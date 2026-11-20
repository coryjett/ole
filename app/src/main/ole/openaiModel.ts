import type { Llm } from '../notes/enhance'
import type { NotesModel } from '../notes/model'

/**
 * Ole: OpenAI as the notes model, behind the same surface as Yogurt's local one (createNotesModel), so the notes,
 * chat and title jobs need no change. The key and model are read on every job, so a Settings change applies to the
 * next one without a restart. The key never goes into an error message or a log.
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

const needKey = (key: string | null | undefined): string => {
  if (!key?.trim()) throw new OpenAIError('Add an OpenAI key in Settings')
  return key.trim()
}

/** the server's own reason, short, with anything key-shaped taken out (a 401 can echo part of the key) */
const reason = async (res: Response, key: string): Promise<string> => {
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
    headers: { Authorization: `Bearer ${r.key}`, 'Content-Type': 'application/json' },
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

/** Yogurt's notes model surface, answered by OpenAI. Embeddings stay local. */
export function createOpenAIModel(o: { key: () => string | null; model: () => string; fetch?: typeof fetch; baseUrl?: string }): NotesModel {
  return {
    async llm(signal?: AbortSignal): Promise<Llm> {
      needKey(o.key())
      return {
        contextSize: OPENAI_CONTEXT,
        count: async (texts) => texts.map((t) => Math.ceil(t.length / 4)),
        chat: async (prompt, onToken, opts) => {
          const key = needKey(o.key())
          // before: an earlier prompt and its answer, in that order (summary is a local-model hint, not needed here)
          const messages: OpenAIMessage[] = [
            ...(opts?.before ?? []).map((content, i): OpenAIMessage => ({ role: i % 2 ? 'assistant' : 'user', content })),
            { role: 'user', content: prompt },
          ]
          const res = await postSampled({ key, model: o.model(), baseUrl: o.baseUrl, fetch: o.fetch, signal, messages, stream: true, maxTokens: opts?.maxTokens, temperature: opts?.temperature })
          return readStream(res, onToken, signal)
        },
      }
    },
    unload: async () => {},
    loaded: () => (o.key()?.trim() ? o.model() : undefined),
    needsLoad: () => false,
  }
}

/**
 * One non-streaming chat completion; resolves with the first choice's message (content and any tool_calls).
 * For callers that want tools or a response_format, which the notes surface does not carry.
 */
export async function openaiChat(o: {
  key: string | null; model: string; messages: OpenAIMessage[]; tools?: unknown[]; response_format?: unknown
  maxTokens?: number; temperature?: number; signal?: AbortSignal; fetch?: typeof fetch; baseUrl?: string
}): Promise<OpenAIMessage> {
  const key = needKey(o.key)
  const res = await postSampled({ ...o, key, stream: false })
  const message = (await res.json())?.choices?.[0]?.message
  if (!message) throw new OpenAIError('OpenAI returned no answer')
  return message as OpenAIMessage
}
