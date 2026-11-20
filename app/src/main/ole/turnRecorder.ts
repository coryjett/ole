// Ole: keeps each live bullets turn of a call (#70), so a saved meeting can be exported as a replay fixture (#66).
// Wraps the engine's chat and lookup functions; the engine itself is unchanged. Kept in memory during the call and
// saved with the meeting on this Mac (meetings/<id>/ole-turns.json). Never logged, never sent anywhere.
import { callKey, type CallToolFn, type ChatFn } from './bullets'
import { classifyFailure, type FailureKind } from './replayFormat'
import { RESULT_CAP } from './tools'

/** a lookup the model asked for and what the server answered (absent when Ole refused it: a repeat, the rate, unknown) */
export type RecordedToolCall = { name: string; arguments?: Record<string, unknown>; result?: string }
/** one model reply: its content, its lookups, or the kind of failure (never the error text); latencyMs: how long it took */
export type RecordedReply = { content?: string | null; toolCalls?: RecordedToolCall[]; error?: FailureKind; latencyMs: number }
/** one bullets turn: when it started (ms from the start of the call) and the model's replies in order */
export type RecordedTurn = { atMs: number; replies: RecordedReply[] }
/** what is saved as ole-turns.json */
export type RecordedCall = {
  version: 1
  /** the briefing's title and focus when the call ended (its text is saved as ole-briefing.md) */
  briefing?: { meetingTitle: string | null; focus: string | null }
  /** every tool name offered to the model during the call */
  tools: string[]
  turns: RecordedTurn[]
}

/** turns kept per call: about 3.75 hours at one turn every 45 s */
export const TURNS_MAX = 300
/** a reply's content is cut to this */
export const CONTENT_CAP = 20_000
/** a lookup result is cut to the runner's own cap plus its "[truncated]" marker, so what the engine saw is kept whole */
const RESULT_KEEP = RESULT_CAP + 20

const toolNames = (tools: unknown): string[] => Array.isArray(tools)
  ? tools.map(t => (t as { function?: { name?: unknown } })?.function?.name).filter((n): n is string => typeof n === 'string')
  : []

const parseArgs = (json: string): Record<string, unknown> | undefined => {
  try { const v: unknown = json?.trim() ? JSON.parse(json) : {}; return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined } catch { return undefined }
}

export function createTurnRecorder(o: { chat: ChatFn; callTool: CallToolFn; now?: () => number; startedAt?: number; max?: number }): {
  chat: ChatFn
  callTool: CallToolFn
  /** a copy of what was recorded so far */
  recorded(): Omit<RecordedCall, 'version' | 'briefing'>
} {
  const now = o.now ?? Date.now
  const startedAt = o.startedAt ?? now()
  const max = o.max ?? TURNS_MAX
  const turns: RecordedTurn[] = []
  const tools = new Set<string>()
  /** the turn the engine is on; null once the cap is reached, so nothing more is kept */
  let current: RecordedTurn | null = null

  const chat: ChatFn = async (req) => {
    // a request ending in the user's message starts a turn; later ones (after lookups) continue it
    if (req.messages.at(-1)?.role === 'user') {
      current = turns.length < max ? { atMs: Math.max(0, now() - startedAt), replies: [] } : null
      if (current) turns.push(current)
    }
    for (const n of toolNames(req.tools)) tools.add(n)
    const turn = current
    const t0 = now()
    try {
      const reply = await o.chat(req)
      const toolCalls = reply.tool_calls?.map(c => {
        const args = parseArgs(c.function.arguments)
        return { name: c.function.name, ...(args ? { arguments: args } : {}) }
      })
      turn?.replies.push({
        ...(typeof reply.content === 'string' ? { content: reply.content.slice(0, CONTENT_CAP) } : toolCalls?.length ? {} : { content: null }),
        ...(toolCalls?.length ? { toolCalls } : {}),
        latencyMs: Math.max(0, now() - t0),
      })
      return reply
    } catch (e) {
      turn?.replies.push({ error: classifyFailure(e instanceof Error ? e.message : String(e)), latencyMs: Math.max(0, now() - t0) })
      throw e
    }
  }

  const callTool: CallToolFn = async (name, argsJson) => {
    const turn = current
    const key = callKey(name, parseArgs(argsJson) ?? {})
    // the lookup belongs to the latest reply that asked for it and has no result yet
    const keep = (result: string) => {
      const c = turn?.replies.at(-1)?.toolCalls?.find(c => c.result === undefined && callKey(c.name, c.arguments ?? {}) === key)
      if (c) c.result = result.slice(0, RESULT_KEEP)
    }
    try { const result = await o.callTool(name, argsJson); keep(result); return result } catch (e) { keep('lookup failed'); throw e }
  }

  return { chat, callTool, recorded: () => ({ tools: [...tools], turns: structuredClone(turns) }) }
}

/** a saved ole-turns.json read back, keeping only well-formed parts; null for anything that is not one */
export function parseRecordedCall(v: unknown): RecordedCall | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (o.version !== 1 || !Array.isArray(o.turns)) return null
  const str = (x: unknown, cap: number) => typeof x === 'string' ? x.slice(0, cap) : undefined
  const turns: RecordedTurn[] = o.turns.slice(0, TURNS_MAX).filter(t => t && typeof t === 'object' && Array.isArray((t as RecordedTurn).replies)).map(t => {
    const turn = t as RecordedTurn
    return {
      atMs: typeof turn.atMs === 'number' && Number.isFinite(turn.atMs) ? turn.atMs : 0,
      replies: turn.replies.slice(0, 10).filter(r => r && typeof r === 'object').map(r => {
        const content = r.content === null ? null : str(r.content, CONTENT_CAP)
        const toolCalls = Array.isArray(r.toolCalls) ? r.toolCalls.slice(0, 20).filter(c => c && typeof c.name === 'string').map(c => ({
          name: c.name.slice(0, 200),
          ...(c.arguments && typeof c.arguments === 'object' && !Array.isArray(c.arguments) ? { arguments: c.arguments } : {}),
          ...(typeof c.result === 'string' ? { result: c.result.slice(0, RESULT_KEEP) } : {}),
        })) : undefined
        return {
          ...(content !== undefined ? { content } : {}),
          ...(toolCalls?.length ? { toolCalls } : {}),
          ...(typeof r.error === 'string' ? { error: classifyFailure(r.error) } : {}),
          latencyMs: typeof r.latencyMs === 'number' && Number.isFinite(r.latencyMs) && r.latencyMs >= 0 ? r.latencyMs : 0,
        }
      }),
    }
  })
  const b = o.briefing && typeof o.briefing === 'object' ? o.briefing as Record<string, unknown> : null
  return {
    version: 1,
    ...(b ? { briefing: { meetingTitle: str(b.meetingTitle, 300) ?? null, focus: str(b.focus, 200) ?? null } } : {}),
    tools: Array.isArray(o.tools) ? o.tools.filter((n): n is string => typeof n === 'string').slice(0, 200).map(n => n.slice(0, 200)) : [],
    turns,
  }
}
