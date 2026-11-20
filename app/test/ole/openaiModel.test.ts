import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOpenAIModel, openaiChat } from '../../src/main/ole/openaiModel'

function sse(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

function sseBody(events: Array<{ content?: string; done?: boolean }>): ReadableStream<Uint8Array> {
  const lines = events.map((e) => {
    if (e.done) return 'data: [DONE]\n\n'
    return `data: ${JSON.stringify({ choices: [{ delta: { content: e.content ?? '' } }] })}\n\n`
  })
  const full = lines.join('')

  // split at awkward points to test buffering
  const cuts = [7, 13, 29, 47, 71, 91, 103]
  const chunks: string[] = []
  let last = 0
  for (const c of cuts) {
    if (c < full.length && c > last) {
      chunks.push(full.slice(last, c))
      last = c
    }
  }
  if (last < full.length) chunks.push(full.slice(last))
  return sse(chunks)
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function streamResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

function parseBody(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body))
}

const KEY = 'sk-test-abc123XYZ'

describe('openaiModel', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let consoleError: ReturnType<typeof vi.spyOn>
  let consoleWarn: ReturnType<typeof vi.spyOn>
  let consoleInfo: ReturnType<typeof vi.spyOn>
  let consoleLog: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchMock = vi.fn()
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {})
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('streams deltas to onToken and resolves with the whole answer', async () => {
    const stream = sseBody([
      { content: 'Hello' },
      { content: ', world' },
      { done: true },
    ])
    fetchMock.mockResolvedValue(streamResponse(stream))

    const model = createOpenAIModel({ key: () => KEY, model: () => 'gpt-4o', fetch: fetchMock as unknown as typeof fetch })
    const llm = await model.llm()
    const tokens: string[] = []
    const answer = await llm.chat('hi', (t) => tokens.push(t))

    expect(answer).toBe('Hello, world')
    expect(tokens).toEqual(['Hello', ', world'])
  })

  it('sends the key as a Bearer token, configured model, max_completion_tokens from maxTokens, and before mapped as user then assistant', async () => {
    const stream = sseBody([{ content: 'ok' }, { done: true }])
    fetchMock.mockResolvedValue(streamResponse(stream))

    const model = createOpenAIModel({ key: () => KEY, model: () => 'gpt-4o-mini', fetch: fetchMock as unknown as typeof fetch })
    const llm = await model.llm()
    await llm.chat('new prompt', () => {}, {
      maxTokens: 123,
      before: ['first message', 'second message'],
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/chat/completions')
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${KEY}` })

    const body = parseBody(init)
    expect(body.model).toBe('gpt-4o-mini')
    expect(body.max_completion_tokens).toBe(123)
    expect(body.messages).toEqual([
      { role: 'user', content: 'first message' },
      { role: 'assistant', content: 'second message' },
      { role: 'user', content: 'new prompt' },
    ])
  })

  it('401 rejects with OpenAI rejected the API key and the key never appears in error or console calls', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: { message: `bad key ${KEY}` } }))

    const model = createOpenAIModel({ key: () => KEY, model: () => 'gpt-4o', fetch: fetchMock as unknown as typeof fetch })
    const llm = await model.llm()

    let caught: unknown
    try {
      await llm.chat('hi', () => {})
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe('OpenAI rejected the API key')
    expect((caught as Error).message).not.toContain(KEY)

    for (const spy of [consoleError, consoleWarn, consoleInfo, consoleLog]) {
      for (const call of spy.mock.calls) {
        for (const arg of call) {
          expect(String(arg)).not.toContain(KEY)
        }
      }
    }
  })

  it('no key rejects with Add an OpenAI key in Settings and fetch is never called', async () => {
    const model = createOpenAIModel({ key: () => null, model: () => 'gpt-4o', fetch: fetchMock as unknown as typeof fetch })

    let caught: unknown
    try {
      await model.llm()
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe('Add an OpenAI key in Settings')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('abort signal cancels the request and rejects', async () => {
    const ac = new AbortController()

    // as a real fetch does: an abort rejects a pending request and errors a body already streaming
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal
      if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'first' } }] })}\n\n`))
          signal?.addEventListener('abort', () => controller.error(new DOMException('The operation was aborted.', 'AbortError')), { once: true })
        },
      })
      return new Response(stream, { status: 200 })
    })

    const model = createOpenAIModel({ key: () => KEY, model: () => 'gpt-4o', fetch: fetchMock as unknown as typeof fetch })
    const llm = await model.llm(ac.signal)

    let caught: unknown
    try {
      await llm.chat('hi', (t) => {
        if (t === 'first') ac.abort()
      })
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).name).toBe('AbortError')
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBe(ac.signal)
  })

  it('other refusals keep the server reason with anything key-shaped taken out', async () => {
    fetchMock.mockResolvedValue(jsonResponse(429, { error: { message: `Rate limit for ${KEY} reached` } }))
    const llm = await createOpenAIModel({ key: () => KEY, model: () => 'gpt-4o', fetch: fetchMock as unknown as typeof fetch }).llm()
    const e = await llm.chat('hi', () => {}).then(() => new Error('resolved'), (x: Error) => x)
    expect(e.message).toBe('OpenAI request failed (429): Rate limit for [key] reached')
  })

  it('400 about temperature retries once without temperature', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(400, { error: { message: 'Invalid value: temperature' } }))
      .mockResolvedValueOnce(streamResponse(sseBody([{ content: 'ok' }, { done: true }])))

    const model = createOpenAIModel({ key: () => KEY, model: () => 'gpt-4o', fetch: fetchMock as unknown as typeof fetch })
    const llm = await model.llm()

    const answer = await llm.chat('hi', () => {}, { temperature: 0.7 })
    expect(answer).toBe('ok')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const firstBody = parseBody(fetchMock.mock.calls[0][1] as RequestInit)
    const secondBody = parseBody(fetchMock.mock.calls[1][1] as RequestInit)
    expect(firstBody.temperature).toBe(0.7)
    expect(secondBody.temperature).toBeUndefined()
  })

  it('openaiChat returns first choice message including tool_calls and sends tools, response_format, stream false', async () => {
    const message = {
      role: 'assistant' as const,
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function' as const, function: { name: 'get_weather', arguments: '{"city":"SF"}' } }],
    }

    fetchMock.mockResolvedValue(jsonResponse(200, { choices: [{ message }] }))

    const tools = [{ type: 'function', function: { name: 'get_weather' } }]
    const response_format = { type: 'json_object' }

    const got = await openaiChat({
      key: KEY,
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'weather?' }],
      tools,
      response_format,
      fetch: fetchMock as unknown as typeof fetch,
    })

    expect(got).toEqual(message)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = parseBody(fetchMock.mock.calls[0][1] as RequestInit)
    expect(body.stream).toBe(false)
    expect(body.tools).toEqual(tools)
    expect(body.response_format).toEqual(response_format)
  })
})

