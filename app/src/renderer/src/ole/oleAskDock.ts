// Ole: the docked Ask panel on a call's note page (#122). The host's Ask button and ⌘J ask Ole first through
// oleAskTakesOver, the one seam in the host's Ask (components/Chat.tsx); everything here is Ole's.
import type { OleAnswer } from '../../../main/ole/core/types'

/** focus functions of the docked panels on screen, by the meeting whose call they answer about */
const docks = new Map<string, () => void>()

/**
 * A docked panel registers while it can answer (this note's call is live and not blocked); the returned function
 * unregisters it. A later panel for the same meeting replaces an earlier one.
 */
export function registerOleAskDock(meetingId: string, focus: () => void): () => void {
  docks.set(meetingId, focus)
  return () => { if (docks.get(meetingId) === focus) docks.delete(meetingId) }
}

/**
 * The host's Ask button or ⌘J on a note page: during a call on that note, Ole's panel is focused instead and this
 * returns true; otherwise false, and the host opens its own Ask as before.
 */
export function oleAskTakesOver(meetingId: string): boolean {
  const focus = docks.get(meetingId)
  if (!focus) return false
  focus()
  return true
}

/**
 * The answers the panel shows, oldest first so the newest sits nearest the box: only the latest unless expanded.
 * answers: as the session keeps them, newest first.
 */
export function shownAnswers(answers: OleAnswer[], expanded: boolean): OleAnswer[] {
  return (expanded ? answers : answers.slice(0, 1)).slice().reverse()
}

/** a handle for one question, so Stop can cancel it (#122) */
export function newAskRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}
