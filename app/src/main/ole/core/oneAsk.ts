// Ole: one Ask (#118). During a call, the host's own Ask about that meeting is answered by Ole's call Ask (ask.ts:
// briefing, running summary, the user's notes, earlier questions and the call's lookups); anything else, and a call
// Ask that can't run or fails, stays with the host's Ask.

/** what a question asked in the host's Ask gets from Ole */
export type OneAskResult =
  /** Ole answered it from the call: show this, with its source (already checked and anonymised) when there is one */
  | { route: 'call'; text: string; source?: string; url?: string }
  /** the host answers it as before; note: one line to put first, when the call's context wasn't available */
  | { route: 'library'; note?: string }

/** the line put before a host answer to a question about the call when Ole couldn't answer it from the call */
export const CALL_CONTEXT_MISSING = "_The call's context wasn't available, so this is answered from the meeting alone._"

/**
 * Where a question asked in the host's Ask goes. Only a question about the meeting being recorded right now (Ole's
 * live meetingId), and only while live context can run (not blocked), goes to the call Ask. A question about that
 * meeting while it is blocked goes to the host's Ask with the note; anything else (another meeting, a library-wide
 * question, no call) to the host's Ask as before.
 */
export function routeAsk(o: { liveMeetingId: string | null; blocked: string | null; meetingId: string | undefined }): { route: 'call' } | { route: 'library'; note?: string } {
  if (!o.meetingId || !o.liveMeetingId || o.meetingId !== o.liveMeetingId) return { route: 'library' }
  return o.blocked ? { route: 'library', note: CALL_CONTEXT_MISSING } : { route: 'call' }
}
