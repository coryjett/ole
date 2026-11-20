// Ole: the replay fixture format (#66) and how a failed turn is named. Shared by the dev-only harness (replay.ts) and
// the app's "Export for replay" (#70), which must not import the harness itself.
import type { TranscriptLine } from './bullets'

/** one lookup the model asked for, and what the server answered when the call was recorded */
export type ReplayToolCall = { name: string; arguments?: Record<string, unknown>; result?: string }
/** one model reply: final bullets (as `bullets` or raw `content`), lookups, or a failure; latencyMs is how long it took */
export type ReplayReply = { content?: string | null; bullets?: unknown[]; toolCalls?: ReplayToolCall[]; error?: string; latencyMs?: number }
/** the model replies of one bullets turn, in order: lookups first (if any), then the answer */
export type ReplayTurn = { replies: ReplayReply[] }

export type ReplayFixture = {
  name: string
  /** the prepared briefing the call had */
  briefing: { meetingTitle?: string | null; focus?: string | null; text: string }
  /** tool names offered to the model, as `<server>__<tool>` */
  tools?: string[]
  /** startMs from the start of the call */
  transcript: TranscriptLine[]
  turns: ReplayTurn[]
  /** when the recording stopped; default 5 s after the last line starts */
  endMs?: number
  /** model latency for replies that do not give their own; default 0 */
  latencyMs?: number
  /** engine settings for this replay; defaults are the app's */
  settings?: { minIntervalMs?: number; windowMs?: number; maxLookupsPerMinute?: number }
}

export type FailureKind = `http ${number}` | 'timeout' | 'network' | 'parse' | 'error'

/**
 * A failed turn as a coarse kind, never its text: the engine's error message can carry a server's words, a URL or
 * part of a key, so the report keeps only an HTTP status or one of timeout, network, parse, error.
 */
export function classifyFailure(reason: string): FailureKind {
  const status = reason.match(/\((\d{3})\)/)?.[1] ?? reason.match(/(?:^|\b(?:status|http|code)\s*:?\s*)([45]\d\d)\b/i)?.[1]
  if (status) return `http ${Number(status)}`
  if (/rejected the api key|unauthori[sz]ed/i.test(reason)) return 'http 401'
  if (/time[d ]?\s?out|abort/i.test(reason)) return 'timeout'
  if (/fetch failed|network|socket|ECONN\w*|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|getaddrinfo/i.test(reason)) return /ETIMEDOUT/.test(reason) ? 'timeout' : 'network'
  if (/json|parse|unexpected token/i.test(reason)) return 'parse'
  return 'error'
}
