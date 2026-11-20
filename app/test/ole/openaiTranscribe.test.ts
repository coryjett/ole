import { describe, expect, it, vi } from 'vitest'
import { createOpenAITranscriber, modelUnsupported } from '../../src/main/ole/yogurt/openaiTranscribe'
import type { Chunk } from '../../src/main/asr/chunker'

function chunk(samples: number, startMs = 0): Chunk {
  return { track: 'me', startMs, samples: new Float32Array(samples) }
}

/** a stand-in fetch answering every call with this transcript */
function okFetch(text: string) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ text }), { status: 200 }))
}

describe('openaiTranscribe', () => {
  it('posts the chunk as WAV with the model and maps the text to a Line on the same track', async () => {
    const f = okFetch('hello there')
    const t = createOpenAITranscriber({
      key: () => 'sk-test',
      model: () => 'gpt-4o-mini-transcribe',
      fetch: f
    })

    const lines = await t(chunk(8000, 1234))

    expect(f).toHaveBeenCalledTimes(1)
    const [url, init] = f.mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions')
    expect((init as RequestInit).method).toBe('POST')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer sk-test' })

    const form = (init as RequestInit).body as FormData
    expect(form.get('model')).toBe('gpt-4o-mini-transcribe')
    expect(form.get('response_format')).toBe('json')

    const file = form.get('file')
    if (!(file instanceof Blob)) throw new Error('expected Blob')
    const bytes = new Uint8Array(await file.arrayBuffer())
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('RIFF')

    expect(lines).toEqual([
      { track: 'me', startMs: 1234, endMs: 1734, text: 'hello there' }
    ])
  })

  it('times the line from the chunk start and its sample length at 16 kHz', async () => {
    const f = okFetch('hi')
    const t = createOpenAITranscriber({
      key: () => 'sk-test',
      model: () => 'model',
      fetch: f
    })

    const lines = await t(chunk(32000, 5000))
    expect(lines[0]?.startMs).toBe(5000)
    expect(lines[0]?.endMs).toBe(7000)
  })

  it('empty text returns no lines', async () => {
    const f = okFetch('   \n\t  ')
    const t = createOpenAITranscriber({
      key: () => 'sk-test',
      model: () => 'model',
      fetch: f
    })

    expect(await t(chunk(8000))).toEqual([])
  })

  it('a 401 throws OpenAI rejected the API key', async () => {
    const f = vi.fn<typeof fetch>(async () => new Response('{}', { status: 401 }))
    const t = createOpenAITranscriber({
      key: () => 'sk-test',
      model: () => 'model',
      fetch: f
    })

    await expect(t(chunk(8000))).rejects.toThrow('OpenAI rejected the API key')
  })

  it('a network failure throws, and the next chunk still transcribes', async () => {
    const f = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: 'ok' }), { status: 200 }))

    const t = createOpenAITranscriber({
      key: () => 'sk-test',
      model: () => 'model',
      fetch: f
    })

    await expect(t(chunk(8000))).rejects.toThrow('boom')
    const lines = await t(chunk(8000))
    expect(lines).toEqual([{ track: 'me', startMs: 0, endMs: 500, text: 'ok' }])
  })

  it('partial requests return [] without a network call', async () => {
    const f = vi.fn<typeof fetch>()
    const t = createOpenAITranscriber({
      key: () => 'sk-test',
      model: () => 'model',
      fetch: f
    })

    expect(await t(chunk(8000), { partial: true })).toEqual([])
    expect(f).not.toHaveBeenCalled()
  })

  it('chunks under 0.3 s return [] without a network call', async () => {
    const f = vi.fn<typeof fetch>()
    const t = createOpenAITranscriber({
      key: () => 'sk-test',
      model: () => 'model',
      fetch: f
    })

    expect(await t(chunk(4799))).toEqual([])
    expect(f).not.toHaveBeenCalled()
  })

  it('no key throws without a network call', async () => {
    const f = vi.fn<typeof fetch>()
    const t = createOpenAITranscriber({
      key: () => '',
      model: () => 'model',
      fetch: f
    })

    await expect(t(chunk(8000))).rejects.toThrow('Add an OpenAI key to transcribe with OpenAI')
    expect(f).not.toHaveBeenCalled()
  })

  describe('gpt-transcribe safety net (#89)', () => {
    const modelOf = (init: unknown) => ((init as RequestInit).body as FormData).get('model')
    /** the body OpenAI sends for a model the account can't use (#111) */
    const notFound = '{"error":{"message":"secret detail","type":"invalid_request_error","param":null,"code":"model_not_found"}}'
    /** answers status (with body) for gpt-transcribe, a transcript for anything else */
    const refusing = (status: number, body = notFound) => vi.fn<typeof fetch>(async (_u, init) => modelOf(init) === 'gpt-transcribe'
      ? new Response(body, { status })
      : new Response(JSON.stringify({ text: 'hallo zusammen' }), { status: 200 }))

    for (const status of [400, 404]) {
      it(`a ${status} retries the chunk once with gpt-4o-mini-transcribe, and the rest of the recording uses it`, async () => {
        const f = refusing(status)
        const log = vi.fn()
        const t = createOpenAITranscriber({ key: () => 'sk-test', model: () => 'gpt-transcribe', fetch: f, log })
        expect(await t(chunk(8000))).toEqual([{ track: 'me', startMs: 0, endMs: 500, text: 'hallo zusammen' }])
        expect(f.mock.calls.map(c => modelOf(c[1]))).toEqual(['gpt-transcribe', 'gpt-4o-mini-transcribe'])
        expect(((f.mock.calls[1][1] as RequestInit).body as FormData).get('file')).toBeInstanceOf(Blob)
        await t(chunk(8000, 1000))
        expect(f.mock.calls.map(c => modelOf(c[1]))).toEqual(['gpt-transcribe', 'gpt-4o-mini-transcribe', 'gpt-4o-mini-transcribe'])
        expect(log).toHaveBeenCalledTimes(1)
        expect(log.mock.calls[0][0]).toBe(`ole: gpt-transcribe transcription answered ${status}; gpt-4o-mini-transcribe for the rest of this recording`)
        expect(log.mock.calls[0][0]).not.toContain('secret')
      })
    }

    for (const status of [401, 403, 429, 500, 503]) {
      it(`a ${status} is not a model problem: no retry, no fallback`, async () => {
        const f = refusing(status)
        const log = vi.fn()
        const t = createOpenAITranscriber({ key: () => 'sk-test', model: () => 'gpt-transcribe', fetch: f, log })
        await expect(t(chunk(8000))).rejects.toThrow()
        expect(f).toHaveBeenCalledTimes(1)
        expect(log).not.toHaveBeenCalled()
        await expect(t(chunk(8000))).rejects.toThrow()
        expect(f.mock.calls.map(c => modelOf(c[1]))).toEqual(['gpt-transcribe', 'gpt-transcribe'])
      })
    }

    it('another chosen model is never swapped', async () => {
      const f = vi.fn<typeof fetch>(async () => new Response('{}', { status: 400 }))
      const log = vi.fn()
      const t = createOpenAITranscriber({ key: () => 'sk-test', model: () => 'gpt-transcribe-2027-01-01', fetch: f, log })
      await expect(t(chunk(8000))).rejects.toThrow('OpenAI transcription answered 400')
      expect(f).toHaveBeenCalledTimes(1)
      expect(log).not.toHaveBeenCalled()
    })

    it('only an error body saying the model or a parameter is unsupported counts (#111)', () => {
      expect(modelUnsupported(notFound)).toBe(true)
      expect(modelUnsupported('{"error":{"code":"unsupported_value","param":"language"}}')).toBe(true)
      expect(modelUnsupported('{"error":{"code":"unsupported_parameter"}}')).toBe(true)
      expect(modelUnsupported('{"error":{"code":null,"param":"model"}}')).toBe(true)
      expect(modelUnsupported('{"error":{"code":"invalid_value","param":"response_format"}}')).toBe(true)
      expect(modelUnsupported('{"error":{"code":"invalid_value","param":"file"}}')).toBe(false)
      expect(modelUnsupported('{"error":{"message":"Audio file is too short"}}')).toBe(false)
      expect(modelUnsupported('<html>Not Found</html>')).toBe(false)
      expect(modelUnsupported('')).toBe(false)
      expect(modelUnsupported('null')).toBe(false)
    })

    for (const status of [400, 404]) {
      it(`a ${status} about something else (the audio, a bad file) is surfaced as before: no retry, no fallback (#111)`, async () => {
        const f = refusing(status, '{"error":{"message":"Invalid file format.","param":"file","code":"invalid_value"}}')
        const log = vi.fn()
        const t = createOpenAITranscriber({ key: () => 'sk-test', model: () => 'gpt-transcribe', fetch: f, log })
        await expect(t(chunk(8000))).rejects.toThrow(`OpenAI transcription answered ${status}`)
        expect(f).toHaveBeenCalledTimes(1)
        expect(log).not.toHaveBeenCalled()
        // and the next chunk still asks for the chosen model
        await expect(t(chunk(8000))).rejects.toThrow()
        expect(f.mock.calls.map(c => modelOf(c[1]))).toEqual(['gpt-transcribe', 'gpt-transcribe'])
      })
    }

    it('a 404 that is not JSON is not a model problem (#111)', async () => {
      const f = refusing(404, 'Not Found')
      const t = createOpenAITranscriber({ key: () => 'sk-test', model: () => 'gpt-transcribe', fetch: f, log: vi.fn() })
      await expect(t(chunk(8000))).rejects.toThrow('OpenAI transcription answered 404')
      expect(f).toHaveBeenCalledTimes(1)
    })

    it('the refused body is read before the retry (#111)', async () => {
      const refused = new Response(notFound, { status: 400 })
      const f = vi.fn<typeof fetch>(async (_u, init) => modelOf(init) === 'gpt-transcribe' ? refused : new Response('{"text":"ok"}', { status: 200 }))
      const t = createOpenAITranscriber({ key: () => 'sk-test', model: () => 'gpt-transcribe', fetch: f, log: vi.fn() })
      await t(chunk(8000))
      expect(refused.bodyUsed).toBe(true)
    })

    it('the retry reads the key again (#111)', async () => {
      const keys = ['sk-old', 'sk-new']
      const key = vi.fn(() => keys.shift() ?? null)
      const f = refusing(400)
      const t = createOpenAITranscriber({ key, model: () => 'gpt-transcribe', fetch: f, log: vi.fn() })
      await t(chunk(8000))
      const auth = (i: number) => ((f.mock.calls[i][1] as RequestInit).headers as Record<string, string>).Authorization
      expect([auth(0), auth(1)]).toEqual(['Bearer sk-old', 'Bearer sk-new'])
    })

    it('a key removed before the retry stops it (#111)', async () => {
      const keys: Array<string | null> = ['sk-old', null]
      const f = refusing(400)
      const t = createOpenAITranscriber({ key: () => keys.shift() ?? null, model: () => 'gpt-transcribe', fetch: f, log: vi.fn() })
      await expect(t(chunk(8000))).rejects.toThrow('Add an OpenAI key to transcribe with OpenAI')
      expect(f).toHaveBeenCalledTimes(1)
    })

    it('a failing retry reports its own status', async () => {
      const f = vi.fn<typeof fetch>(async () => new Response('{"error":{"code":"model_not_found"}}', { status: 404 }))
      const t = createOpenAITranscriber({ key: () => 'sk-test', model: () => 'gpt-transcribe', fetch: f, log: vi.fn() })
      await expect(t(chunk(8000))).rejects.toThrow('OpenAI transcription answered 404')
      expect(f).toHaveBeenCalledTimes(2)
    })
  })
})
