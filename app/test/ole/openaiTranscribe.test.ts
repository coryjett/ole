import { describe, expect, it, vi } from 'vitest'
import { createOpenAITranscriber } from '../../src/main/ole/openaiTranscribe'
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
})
