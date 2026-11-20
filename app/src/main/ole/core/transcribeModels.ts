// Ole: OpenAI transcription models that are retiring, and what replaces them (#89). Pure, no imports: Settings (the
// renderer) reads the same table to label the model dropdown.
//
// Source: OpenAI's deprecations page (https://developers.openai.com/api/docs/deprecations) and transcription guide
// (https://developers.openai.com/api/docs/guides/transcription). whisper-1 and the gpt-4o transcribe models shut down
// on 2027-02-26; the gpt-4o-mini-transcribe-2025-03-20 snapshot earlier, on 2026-12-01. The file-transcription
// successor on /audio/transcriptions is gpt-transcribe (gpt-live-transcribe is Realtime only).

/** the supported model for file and chunk transcription on /audio/transcriptions */
export const TRANSCRIBE_SUCCESSOR = 'gpt-transcribe'

/**
 * The chunked transcriber's safety net: OpenAI's docs don't say outright that gpt-transcribe takes response_format=json
 * on /audio/transcriptions. If a gpt-transcribe request is refused as a bad request (400) or unknown (404), the chunk is
 * sent again with this model, which is served until 2027-02-26, and the rest of that recording uses it.
 */
export const TRANSCRIBE_FALLBACK = 'gpt-4o-mini-transcribe'

const SHUTDOWN = '2027-02-26'

/** retiring model name: its shutdown date (YYYY-MM-DD). A Map, so a name like "constructor" or "__proto__" finds nothing */
const RETIRING: ReadonlyMap<string, string> = new Map([
  ['whisper-1', SHUTDOWN],
  ['gpt-4o-transcribe', SHUTDOWN],
  ['gpt-4o-mini-transcribe', SHUTDOWN],
  ['gpt-4o-mini-transcribe-2025-12-15', SHUTDOWN],
  ['gpt-4o-mini-transcribe-2025-03-20', '2026-12-01'],
  ['gpt-4o-transcribe-diarize', SHUTDOWN],
])

/** the same families with a dated snapshot the table doesn't name: they go with their family */
const FAMILY = /^(whisper-1|gpt-4o-transcribe|gpt-4o-mini-transcribe|gpt-4o-transcribe-diarize)-\d{4}-\d{2}-\d{2}$/

const YMD = /^\d{4}-\d{2}-\d{2}$/

/** when OpenAI shuts this transcription model down (YYYY-MM-DD), or null when it isn't retiring */
export function transcribeModelRetires(model: string): string | null {
  if (typeof model !== 'string') return null
  const m = model.trim().toLowerCase()
  const f = FAMILY.exec(m)
  const date = RETIRING.get(m) ?? (f ? RETIRING.get(f[1]) : undefined)
  return typeof date === 'string' && YMD.test(date) ? date : null
}

/** a retiring model mapped to the successor, with what it was; anything else unchanged */
export function migrateTranscribeModel(model: string): { model: string; switched: { from: string; to: string; retires: string } | null } {
  const retires = transcribeModelRetires(model)
  return retires ? { model: TRANSCRIBE_SUCCESSOR, switched: { from: model.trim(), to: TRANSCRIBE_SUCCESSOR, retires } } : { model, switched: null }
}

/** '2027-02-26' as 'February 26, 2027' (UTC, so the day never shifts) */
export function retireDateText(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? ymd : d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
}
