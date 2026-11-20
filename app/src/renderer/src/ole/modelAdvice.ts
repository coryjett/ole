// Ole: which class of OpenAI model suits each job (#13). Name rules only, since model names change: kept here, tested.

export type ModelRole = 'transcribe' | 'prepare' | 'live'

export const MODEL_ADVICE: Record<ModelRole, string> = {
  transcribe: 'Recommended: a speech-to-text model (…-transcribe). Mini is fast and cheap; the full one is more accurate with accents, crosstalk or poor audio.',
  prepare: 'Recommended: a mid or large model (a terra or full-size tier). It chooses among many tools and writes the briefing, and a short wait before a call is fine. Avoid nano and mini here.',
  live: 'Recommended: a small, fast model (a luna or mini tier). Bullets have to land while the topic is still on; large models lag and cost more per call.',
}

/** a model id in the recommended class for this job */
export function isRecommended(role: ModelRole, id: string): boolean {
  const m = id.toLowerCase()
  if (role === 'transcribe') return m.includes('transcribe')
  if (/(nano|transcribe|tts|audio|realtime)/.test(m)) return false
  if (role === 'prepare') return /terra/.test(m) || /^gpt-5(\.\d+)?(-\d{4}-\d{2}-\d{2})?$/.test(m)
  return /luna/.test(m) || /-mini(-|$)/.test(m)
}
