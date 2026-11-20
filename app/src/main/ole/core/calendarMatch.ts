// Ole: which calendar event a call or a briefing belongs to (#52, #56).
import { englishGenericTitle, type GenericTitle } from './titles'

export type Upcoming = { id: string; title: string; start: number; end: number }

/** a call is "this meeting" if the meeting is on now or starts within this much */
export const NOW_WINDOW_MS = 15 * 60_000
/** longer than this is an all-day or out-of-office block, not a meeting */
const LONGEST_MS = 12 * 60 * 60_000

const isMeeting = (e: Upcoming) => e.end - e.start < LONGEST_MS && !!e.title.trim()

/** the event on now or starting within the window; the one whose start is closest to now wins */
export function eventNow<T extends Upcoming>(events: T[], now: number, windowMs = NOW_WINDOW_MS): T | null {
  const near = events.filter(e => isMeeting(e) && e.start <= now + windowMs && e.end > now)
  near.sort((a, b) => Math.abs(a.start - now) - Math.abs(b.start - now))
  return near[0] ?? null
}

/** the soonest meeting starting within the lead time that has a real title and was not prepared yet */
/** genericTitle: the host's own check (its interface language), English by default */
export function pickAutoPrepare<T extends Upcoming>(events: T[], now: number, leadMs: number, done: Set<string>, genericTitle: GenericTitle = englishGenericTitle): T | null {
  const due = events.filter(e => isMeeting(e) && e.start > now && e.start <= now + leadMs && !done.has(e.id) && !genericTitle(e.title))
  due.sort((a, b) => a.start - b.start)
  return due[0] ?? null
}

/** the next meeting for Home (#126): the one on now or the soonest coming up, any title */
export function nextMeeting<T extends Upcoming>(events: T[], now: number): T | null {
  const ahead = events.filter(e => isMeeting(e) && e.end > now)
  ahead.sort((a, b) => a.start - b.start)
  return ahead[0] ?? null
}

/** the same calendar event: the same id, or the same title and start (#128) */
export function sameEvent(a: Upcoming | null | undefined, b: Upcoming | null | undefined): boolean {
  if (!a || !b) return false
  return a.id === b.id || (a.title === b.title && a.start === b.start)
}
