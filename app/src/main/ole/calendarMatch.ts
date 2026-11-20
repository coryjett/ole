// Ole: which calendar event a call or a briefing belongs to (#52, #56).
import { genericTitle } from '../titles'

export type Upcoming = { id: string; title: string; start: number; end: number }

/** a call is "this meeting" if the meeting is on now or starts within this much */
export const NOW_WINDOW_MS = 15 * 60_000
/** longer than this is an all-day or out-of-office block, not a meeting */
const LONGEST_MS = 12 * 60 * 60_000

const isMeeting = (e: Upcoming) => e.end - e.start < LONGEST_MS && !!e.title.trim()

/** the event on now or starting within the window; the one whose start is closest to now wins */
export function eventNow(events: Upcoming[], now: number, windowMs = NOW_WINDOW_MS): Upcoming | null {
  const near = events.filter(e => isMeeting(e) && e.start <= now + windowMs && e.end > now)
  near.sort((a, b) => Math.abs(a.start - now) - Math.abs(b.start - now))
  return near[0] ?? null
}

/** the soonest meeting starting within the lead time that has a real title and was not prepared yet */
export function pickAutoPrepare(events: Upcoming[], now: number, leadMs: number, done: Set<string>): Upcoming | null {
  const due = events.filter(e => isMeeting(e) && e.start > now && e.start <= now + leadMs && !done.has(e.id) && !genericTitle(e.title))
  due.sort((a, b) => a.start - b.start)
  return due[0] ?? null
}
