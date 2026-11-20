import type { Chunk } from '../../asr/chunker'
import { wavBytes, type Line, type Transcribe } from '../../asr/transcribe'

/** 0.3 s at 16 kHz */
const MIN_SAMPLES = 4800

/**
 * Ole: transcription through OpenAI's /audio/transcriptions, behind Yogurt's Transcribe seam. One request per finished
 * chunk; no partials in v1 (Apple's speech still shows live words where it runs). A failed chunk throws, so the pipeline's
 * warning path reports it and later chunks still go out. The key is read per chunk, so adding it mid-call takes effect.
 */
export function createOpenAITranscriber(o: {
  key: () => string | null
  model: () => string
  fetch?: typeof fetch
  baseUrl?: string
}): Transcribe {
  const base = (o.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '')
  const fetchFn = o.fetch ?? fetch

  return async function transcribe(c: Chunk, opts?: { partial?: boolean }): Promise<Line[]> {
    if (opts?.partial) return []
    // under 0.3 s at 16 kHz: too short to hold a word, and a paid request for nothing
    if (c.samples.length < MIN_SAMPLES) return []

    const key = o.key()
    if (!key) throw new Error('Add an OpenAI key to transcribe with OpenAI')

    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(wavBytes(c.samples))], { type: 'audio/wav' }), 'chunk.wav')
    form.append('model', o.model())
    form.append('response_format', 'json')

    const res = await fetchFn(`${base}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`
      },
      body: form,
      signal: AbortSignal.timeout(60_000)
    })

    if (res.status === 401) throw new Error('OpenAI rejected the API key')
    if (!res.ok) throw new Error(`OpenAI transcription answered ${res.status}`)

    const body = await res.json() as { text?: string }
    const text = (body.text ?? '').replace(/\s+/g, ' ').trim()
    if (!text) return []

    const endMs = c.startMs + Math.round(c.samples.length / 16)
    return [{ track: c.track, startMs: c.startMs, endMs, text }]
  }
}
