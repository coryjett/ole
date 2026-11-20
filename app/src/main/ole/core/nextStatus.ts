// Ole: what Home says about the next meeting's briefing (#142). Only Ole's own Prepare decides it: before
// auto-prepare runs the line says when it will, never "No match" from the server's calendar.

/**
 * scheduled: auto-prepare will prepare it (preparesAt); preparing: a Prepare is running; ready: prepared for it and the
 * briefing matched a record; no-match: prepared for it and it matched none; idle: not prepared and nothing will (auto-
 * prepare off, or it won't pick this meeting), so Home offers only Prepare for…
 */
export type NextStatus = 'scheduled' | 'preparing' | 'ready' | 'no-match' | 'idle'

export type NextStatusInput = {
  /** auto-prepare is on and will pick this meeting (a real title, not prepared automatically yet, Ole not blocked) */
  autoPrepare: boolean
  /** auto-prepare's lead time */
  leadMs: number
  now: number
  /** the meeting's start */
  start: number
  /** Ole prepared for this meeting: whether that briefing matched a record; null when it hasn't */
  prepared: { matched: boolean } | null
  /** a Prepare is running */
  preparing: boolean
}

export function nextStatus(i: NextStatusInput): { status: NextStatus; preparesAt: number | null } {
  if (i.preparing) return { status: 'preparing', preparesAt: null }
  if (i.prepared) return { status: i.prepared.matched ? 'ready' : 'no-match', preparesAt: null }
  // auto-prepare picks a meeting only before it starts; until its next run the time it was due still stands
  if (i.autoPrepare && i.start > i.now) return { status: 'scheduled', preparesAt: i.start - i.leadMs }
  return { status: 'idle', preparesAt: null }
}

/** HH:MM in local time, 24-hour */
export function clockTime(ms: number): string {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(d.getHours())}:${two(d.getMinutes())}`
}

/** the state label after the meeting on Home's "Next:" line; null shows none */
export function nextStatusLabel(n: { status: NextStatus; preparesAt: number | null }): string | null {
  switch (n.status) {
    case 'scheduled': return n.preparesAt !== null && clockTime(n.preparesAt) ? `Prepares at ${clockTime(n.preparesAt)}` : null
    case 'preparing': return 'Preparing…'
    case 'ready': return 'Briefing ready'
    case 'no-match': return 'No match'
    default: return null
  }
}
