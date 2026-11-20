/**
 * Ole: the OpenAI chat client (OpenAI or any OpenAI-compatible server, #17). Host-agnostic: plain fetch. The host's
 * notes-model wrapper (yogurt/openaiModel.ts) streams text through openaiText. The key never goes into an error
 * message or a log.
 */

export const OPENAI_BASE_URL = 'https://api.openai.com/v1'
/** what the notes see as the model's window; the jobs split a long meeting to fit it */
export const OPENAI_CONTEXT = 128_000

/** one message of an OpenAI chat completion, as sent and as answered */
export type OpenAIMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
  name?: string
}

/** an OpenAI error the caller can show as is; status says what went wrong */
export class OpenAIError extends Error {
  constructor(message: string, readonly status?: number) { super(message) }
}

/** some proxies in front of self-hosted servers block default client user agents (#17) */
export const OLE_USER_AGENT = 'Ole (+https://github.com/coryjett/ole)'

/** OpenAI needs a key; a custom server (another baseUrl) may run without one (#17) */
export const needKey = (key: string | null | undefined, baseUrl?: string): string => {
  if (key?.trim()) return key.trim()
  if (baseUrl && baseUrl.replace(/\/+$/, '') !== OPENAI_BASE_URL) return ''
  throw new OpenAIError('Add an OpenAI key in Settings')
}

/** the server's own reason, short, with anything key-shaped taken out (a 401 can echo part of the key) */
export const reason = async (res: Response, key: string): Promise<string> => {
  try {
    const m = (await res.json())?.error?.message
    if (typeof m !== 'string') return ''
    return m.split(key).join('[key]').replace(/sk-[A-Za-z0-9_*-]+/g, '[key]').slice(0, 200)
  } catch { return '' }
}

type Request = {
  key: string; model: string; baseUrl?: string; fetch?: typeof fetch; signal?: AbortSignal
  messages: OpenAIMessage[]; stream: boolean; maxTokens?: number; temperature?: number; tools?: unknown[]; response_format?: unknown
  /** false: leave reasoning_effort out (a model that does not take it, see postSampled) */
  reasoning?: boolean
}

/** POST /chat/completions; a refused request rejects with a readable OpenAIError */
async function post(r: Request): Promise<Response> {
  const body: Record<string, unknown> = { model: r.model, stream: r.stream, messages: r.messages }
  if (r.maxTokens) body.max_completion_tokens = r.maxTokens
  if (r.temperature !== undefined) body.temperature = r.temperature
  if (r.tools?.length) {
    body.tools = r.tools
    // gpt-5.6 and later refuse function tools on Chat Completions unless reasoning is off (#3)
    if (r.reasoning !== false) body.reasoning_effort = 'none'
  }
  if (r.response_format !== undefined) body.response_format = r.response_format
  const res = await (r.fetch ?? fetch)(`${(r.baseUrl ?? OPENAI_BASE_URL).replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { ...(r.key ? { Authorization: `Bearer ${r.key}` } : {}), 'Content-Type': 'application/json', 'User-Agent': OLE_USER_AGENT },
    body: JSON.stringify(body),
    signal: r.signal,
  })
  if (res.ok) return res
  if (res.status === 401) throw new OpenAIError('OpenAI rejected the API key', 401)
  const why = await reason(res, r.key)
  throw new OpenAIError(`OpenAI request failed (${res.status})${why ? `: ${why}` : ''}`, res.status)
}

/**
 * Some models take only the default temperature, and older ones do not know reasoning_effort: a 400 naming either
 * is asked again without it, once each.
 */
async function postSampled(r: Request): Promise<Response> {
  try { return await post(r) } catch (e) {
    if (!(e instanceof OpenAIError) || e.status !== 400) throw e
    if (r.temperature !== undefined && /temperature/i.test(e.message)) return postSampled({ ...r, temperature: undefined })
    if (r.tools?.length && r.reasoning !== false && /reasoning_effort/i.test(e.message) && !/tools/i.test(e.message)) return postSampled({ ...r, reasoning: false })
    throw e
  }
}

/** reads the SSE stream, each delta to onToken; resolves with the whole answer */
async function readStream(res: Response, onToken: (text: string) => void, signal?: AbortSignal): Promise<string> {
  if (!res.body) throw new OpenAIError('OpenAI returned no answer')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  /** false once the stream says it is done */
  const line = (l: string): boolean => {
    const s = l.trim()
    if (!s.startsWith('data:')) return true
    const data = s.slice(5).trim()
    if (data === '[DONE]') return false
    try {
      const piece = JSON.parse(data)?.choices?.[0]?.delta?.content
      if (typeof piece === 'string' && piece) { text += piece; onToken(piece) }
    } catch { /* a keep-alive or a malformed event: skipped */ }
    return true
  }
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted')
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const l of lines) if (!line(l)) return text
    }
    line(buffer + decoder.decode())
  } finally {
    reader.cancel().catch(() => {})
  }
  if (signal?.aborted) throw signal.reason ?? new Error('aborted')
  return text
}

/**
 * One streamed text answer to plain messages (no tools), each piece to onToken; resolves with the whole text. What a
 * host's notes model needs; the temperature and reasoning fallbacks of postSampled apply.
 */
export async function openaiText(o: {
  key: string; model: string; baseUrl?: string; fetch?: typeof fetch; signal?: AbortSignal
  messages: OpenAIMessage[]; maxTokens?: number; temperature?: number; onToken: (text: string) => void
}): Promise<string> {
  const { onToken, ...rest } = o
  const res = await postSampled({ ...rest, stream: true })
  return readStream(res, onToken, o.signal)
}

/** the first choice's message of a non-streamed answer */
async function messageOf(res: Response): Promise<OpenAIMessage> {
  const message = (await res.json())?.choices?.[0]?.message
  if (!message) throw new OpenAIError('OpenAI returned no answer')
  return message as OpenAIMessage
}

/**
 * Reads a streamed answer (#84) into the same message a non-streamed one gives: content, and tool_calls put together
 * from their pieces. Each content piece goes to onDelta until a tool call starts (a reply that looks things up is not
 * the answer). Throws when the stream breaks, carries an error or ends without saying it is done; null when it held
 * no events at all.
 */
async function readMessageStream(res: Response, onDelta: (text: string) => void, signal?: AbortSignal): Promise<OpenAIMessage | null> {
  if (!res.body) return null
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = '', content = '', events = 0, finished = false, calling = false
  const calls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = []
  const line = (l: string) => {
    const s = l.trim()
    if (!s.startsWith('data:')) return
    const data = s.slice(5).trim()
    if (data === '[DONE]') { finished = true; return }
    let event: { error?: unknown; choices?: Array<{ delta?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown }> }
    try { event = JSON.parse(data) } catch { return /* a keep-alive or a malformed event: skipped */ }
    if (event?.error) throw new OpenAIError('OpenAI stopped the answer')
    events++
    const choice = event?.choices?.[0]
    if (choice?.finish_reason) finished = true
    const delta = choice?.delta
    if (Array.isArray(delta?.tool_calls)) for (const raw of delta.tool_calls as Array<Record<string, unknown>>) {
      calling = true
      const i = typeof raw?.index === 'number' ? raw.index : calls.length
      const fn = (raw?.function ?? {}) as { name?: unknown; arguments?: unknown }
      const c = calls[i] ??= { id: '', type: 'function', function: { name: '', arguments: '' } }
      if (typeof raw.id === 'string') c.id += raw.id
      if (typeof fn.name === 'string') c.function.name += fn.name
      if (typeof fn.arguments === 'string') c.function.arguments += fn.arguments
    }
    if (typeof delta?.content === 'string' && delta.content) {
      content += delta.content
      if (!calling) onDelta(delta.content)
    }
  }
  try {
    while (!finished) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted')
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const l of lines) line(l)
    }
    if (!finished) line(buffer + decoder.decode())
  } finally {
    reader.cancel().catch(() => {})
  }
  if (!events) return null
  if (!finished) throw new OpenAIError('OpenAI stopped the answer')
  const toolCalls = calls.filter(Boolean)
  return { role: 'assistant', content: content || (toolCalls.length ? null : ''), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }
}

/**
 * One chat completion; resolves with the first choice's message (content and any tool_calls). For callers that want
 * tools or a response_format, which the notes surface does not carry.
 *
 * With onDelta (#84) the answer is streamed and each content piece goes to onDelta as it arrives; the message it
 * resolves with is the same as without. A server that ignores `stream` and answers whole is read as is. One that
 * refuses it, breaks mid-stream or sends nothing usable is asked again without streaming, and that answer is the one
 * returned (the caller must not show twice what it already took from the pieces).
 */
export async function openaiChat(o: {
  key: string | null; model: string; messages: OpenAIMessage[]; tools?: unknown[]; response_format?: unknown
  maxTokens?: number; temperature?: number; signal?: AbortSignal; fetch?: typeof fetch; baseUrl?: string
  onDelta?: (text: string) => void
}): Promise<OpenAIMessage> {
  const { onDelta, ...rest } = o
  const key = needKey(o.key, o.baseUrl)
  if (onDelta) {
    let res: Response | null = null
    try { res = await postSampled({ ...rest, key, stream: true }) } catch (e) {
      // a server that does not take `stream` says so with a 400; anything else fails as it would without streaming
      if (!(e instanceof OpenAIError) || e.status !== 400 || !/stream/i.test(e.message)) throw e
    }
    if (res) {
      if (/application\/json/i.test(res.headers.get('content-type') ?? '')) return messageOf(res)
      try {
        const m = await readMessageStream(res, onDelta, o.signal)
        if (m) return m
      } catch (e) {
        if (o.signal?.aborted) throw e
      }
    }
  }
  return messageOf(await postSampled({ ...rest, key, stream: false }))
}
