import type { Chunk } from '../../asr/chunker'
import { wavBytes, type Line, type Transcribe } from '../../asr/transcribe'
import { TRANSCRIBE_FALLBACK, TRANSCRIBE_SUCCESSOR } from '../core/transcribeModels'

/** 0.3 s at 16 kHz */
const MIN_SAMPLES = 4800

/**
 * Ole: transcription through OpenAI's /audio/transcriptions, behind Yogurt's Transcribe seam. One request per finished
 * chunk; no partials in v1 (Apple's speech still shows live words where it runs). A failed chunk throws, so the pipeline's
 * warning path reports it and later chunks still go out. The key is read per chunk, so adding it mid-call takes effect.
 *
 * Safety net (#89, #111): when a gpt-transcribe request answers 400 or 404 and its error body says the model or a
 * parameter isn't supported (modelUnsupported), that chunk is sent once more with TRANSCRIBE_FALLBACK, with the key read
 * again, and this transcriber (one recording) keeps using it. Any other 400 or 404, a rejected key, a rate limit or a
 * server error is not a model problem and never triggers it. One log line, with the status only.
 */
/** error codes that say the model or a parameter isn't supported (#111) */
const UNSUPPORTED_CODE = /^(?:model_not_found|unsupported_[a-z_]*)$/
/** the parameters whose rejection means the model, not the request, is the problem (#111) */
const MODEL_PARAMS = new Set(['model', 'response_format'])

/**
 * Whether a 400 or 404 body from /audio/transcriptions says the model or a parameter isn't supported (#111): an
 * OpenAI error with code model_not_found or unsupported_*, or one naming the model or response_format parameter.
 * Anything else, including a body that isn't JSON, is not.
 */
export function modelUnsupported(body: string): boolean {
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { return false }
  const error = (parsed as { error?: unknown } | null)?.error
  if (!error || typeof error !== 'object') return false
  const { code, param } = error as { code?: unknown; param?: unknown }
  return (typeof code === 'string' && UNSUPPORTED_CODE.test(code)) || (typeof param === 'string' && MODEL_PARAMS.has(param))
}

/** a refused response's body, read so the connection is freed; '' when it can't be read */
const drain = async (res: Response): Promise<string> => { try { return await res.text() } catch { return '' } }

export function createOpenAITranscriber(o: {
  key: () => string | null
  model: () => string
  fetch?: typeof fetch
  baseUrl?: string
  /** the one line written when the fallback starts (default console.warn) */
  log?: (line: string) => void
}): Transcribe {
  const base = (o.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '')
  const fetchFn = o.fetch ?? fetch
  const log = o.log ?? ((l: string) => console.warn(l))
  /** gpt-transcribe was refused once: the rest of this recording uses the fallback */
  let fellBack = false

  const post = (key: string, samples: Float32Array, model: string) => {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(wavBytes(samples))], { type: 'audio/wav' }), 'chunk.wav')
    form.append('model', model)
    form.append('response_format', 'json')
    return fetchFn(`${base}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`
      },
      body: form,
      signal: AbortSignal.timeout(60_000)
    })
  }

  return async function transcribe(c: Chunk, opts?: { partial?: boolean }): Promise<Line[]> {
    if (opts?.partial) return []
    // under 0.3 s at 16 kHz: too short to hold a word, and a paid request for nothing
    if (c.samples.length < MIN_SAMPLES) return []

    const key = o.key()
    if (!key) throw new Error('Add an OpenAI key to transcribe with OpenAI')

    const chosen = o.model()
    const isSuccessor = chosen.trim().toLowerCase() === TRANSCRIBE_SUCCESSOR
    let res = await post(key, c.samples, isSuccessor && fellBack ? TRANSCRIBE_FALLBACK : chosen)
    if (isSuccessor && !fellBack && (res.status === 400 || res.status === 404)) {
      const status = res.status
      // the refused body is read (and then dropped) either way: it decides the fallback and frees the connection
      if (!modelUnsupported(await drain(res))) throw new Error(`OpenAI transcription answered ${status}`)
      fellBack = true
      log(`ole: ${TRANSCRIBE_SUCCESSOR} transcription answered ${status}; ${TRANSCRIBE_FALLBACK} for the rest of this recording`)
      // the key may have been changed or removed while the first request ran
      const again = o.key()
      if (!again) throw new Error('Add an OpenAI key to transcribe with OpenAI')
      res = await post(again, c.samples, TRANSCRIBE_FALLBACK)
    }

    if (!res.ok) await res.body?.cancel().catch(() => undefined)
    if (res.status === 401) throw new Error('OpenAI rejected the API key')
    if (!res.ok) throw new Error(`OpenAI transcription answered ${res.status}`)

    const body = await res.json() as { text?: string }
    const text = (body.text ?? '').replace(/\s+/g, ' ').trim()
    if (!text) return []

    const endMs = c.startMs + Math.round(c.samples.length / 16)
    return [{ track: c.track, startMs: c.startMs, endMs, text }]
  }
}
