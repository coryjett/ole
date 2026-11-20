// Ole: thumbs up or down on bullets (#55), kept across calls so later calls surface more of what helped.
import type { OleSettings, SettingsStore } from './host'

/** rated bullets kept per kind, newest first */
export const FEEDBACK_KEEP = 20

export type Feedback = { useful: string[]; notUseful: string[] }

const clean = (v: unknown): string[] => Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string' && !!t.trim()).slice(0, FEEDBACK_KEEP) : []

export function feedbackOf(settings: OleSettings): Feedback {
  const f = settings.oleFeedback
  return { useful: clean(f?.useful), notUseful: clean(f?.notUseful) }
}

/** a bullet's text rated up or down; null takes the rating back. A text is only ever in one list. */
export function recordRating(store: SettingsStore, text: string, rating: 'up' | 'down' | null): Feedback {
  const t = text.trim().slice(0, 200)
  const f = feedbackOf(store.get())
  const useful = f.useful.filter(x => x !== t), notUseful = f.notUseful.filter(x => x !== t)
  if (t && rating === 'up') useful.unshift(t)
  if (t && rating === 'down') notUseful.unshift(t)
  const next = { useful: useful.slice(0, FEEDBACK_KEEP), notUseful: notUseful.slice(0, FEEDBACK_KEEP) }
  store.patch({ oleFeedback: next })
  return next
}
