// Ole: which class of OpenAI model suits each job (#13). Name rules only, since model names change: kept here, tested.
import { TRANSCRIBE_SUCCESSOR, retireDateText, transcribeModelRetires } from '../../../main/ole/core/transcribeModels'

export type ModelRole = 'transcribe' | 'prepare' | 'live'

export const MODEL_ADVICE: Record<ModelRole, string> = {
  transcribe: `Recommended: ${TRANSCRIBE_SUCCESSOR}, OpenAI's speech-to-text model for recorded audio. whisper-1 and the gpt-4o transcribe models retire on ${retireDateText('2027-02-26')}.`,
  prepare: 'Recommended: a mid or large model (a terra or full-size tier). It chooses among many tools and writes the briefing, and a short wait before a call is fine. Avoid nano and mini here.',
  live: 'Recommended: a small, fast model (a luna or mini tier). Bullets have to land while the topic is still on; large models lag and cost more per call.',
}

/** a model id in the recommended class for this job */
export function isRecommended(role: ModelRole, id: string): boolean {
  const m = id.toLowerCase()
  // not a retiring model (#89), nor a Realtime-only one, which /audio/transcriptions refuses
  if (role === 'transcribe') return m.includes('transcribe') && !transcribeModelRetires(m) && !/(live|realtime)/.test(m)
  if (/(nano|transcribe|tts|audio|realtime)/.test(m)) return false
  if (role === 'prepare') return /terra/.test(m) || /^gpt-5(\.\d+)?(-\d{4}-\d{2}-\d{2})?$/.test(m)
  return /luna/.test(m) || /-mini(-|$)/.test(m)
}

/** the shutdown date as text when this is a retiring transcription model (#89), else null */
export function retiringText(role: ModelRole, id: string): string | null {
  const d = role === 'transcribe' ? transcribeModelRetires(id) : null
  return d ? retireDateText(d) : null
}

/** how a model reads in its dropdown: "(recommended)", "(retiring <date>)" or just the name */
export function modelLabel(role: ModelRole, id: string): string {
  const retiring = retiringText(role, id)
  if (retiring) return `${id} (retiring ${retiring})`
  return isRecommended(role, id) ? `${id} (recommended)` : id
}
