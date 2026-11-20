// Ole: a running summary of the call (#75), so live bullets and Ask keep what was discussed beyond the last few
// minutes. Updated in the background from the previous state and only the lines since, never blocking a turn.
// Structured (#82): the summary text, the questions raised and still open, and the commitments (who will do what).
import type { ChatFn, TranscriptLine } from './bullets'
import type { OleAnswer, OleCallMemory, OleCommitment } from './types'

/** how much new conversation triggers an update */
export const SUMMARY_EVERY_MS = 3 * 60_000
/** the summary is kept to about this many characters */
export const SUMMARY_MAX = 1200
/** open questions and commitments kept, each (#82) */
export const LIST_MAX = 8
/** an open question or a commitment is cut to this */
export const ITEM_MAX = 140

export const SUMMARY_SYSTEM = [
  'You keep a running record of a live call for the user, who is on it.',
  'Given the record so far and the newest part of the conversation, reply with the updated record as JSON only:',
  '{"summary":"...","openQuestions":["..."],"commitments":[{"who":"...","what":"..."}]}',
  '"summary": plain short lines, about 150 words at most. Keep topics discussed, decisions and names of things (products, features, numbers, dates). Drop small talk.',
  '"openQuestions": questions raised on the call that are still unanswered, each one short line. Drop a question once it has been answered.',
  '"commitments": what someone on the call said they will do. "who" is the person or side as the call names them ("Me" for the user), "what" one short line. Keep earlier commitments unless they were withdrawn.',
  `At most ${LIST_MAX} of each. Never invent anything; when the new part adds nothing, return the record unchanged.`,
].join('\n')

export const EMPTY_MEMORY: OleCallMemory = { summary: '', openQuestions: [], commitments: [] }

const clock = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }
const clip = (s: string, n: number) => s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`
const line = (v: unknown): string => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''

function questions(v: unknown): string[] {
  const out: string[] = [], seen = new Set<string>()
  for (const item of v as unknown[]) {
    const q = clip(line(item), ITEM_MAX)
    if (!q || seen.has(q.toLowerCase())) continue
    seen.add(q.toLowerCase()); out.push(q)
    if (out.length === LIST_MAX) break
  }
  return out
}

function commitments(v: unknown): OleCommitment[] {
  const out: OleCommitment[] = [], seen = new Set<string>()
  for (const item of v as unknown[]) {
    const o = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : null
    const what = clip(line(o ? o.what : item), ITEM_MAX)
    if (!what) continue
    const who = clip(line(o?.who), 60)
    const key = `${who.toLowerCase()}|${what.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key); out.push({ who, what })
    if (out.length === LIST_MAX) break
  }
  return out
}

/**
 * The model's reply as the call's record (#82), defensively: a field that is missing or the wrong shape keeps its
 * previous value, an empty list is a real answer (every question answered). null: not a JSON object at all.
 */
export function parseCallMemory(content: string | null, previous: OleCallMemory): OleCallMemory | null {
  const body = (content ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { return null }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const o = parsed as Record<string, unknown>
  const summary = typeof o.summary === 'string' && o.summary.trim() ? o.summary.trim().slice(0, SUMMARY_MAX) : previous.summary
  return {
    summary,
    openQuestions: Array.isArray(o.openQuestions) ? questions(o.openQuestions) : previous.openQuestions,
    commitments: Array.isArray(o.commitments) ? commitments(o.commitments) : previous.commitments,
  }
}

/** a saved record read back from disk, or null when it is not one */
export function savedCallMemory(v: unknown): OleCallMemory | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  return {
    summary: typeof o.summary === 'string' ? o.summary.slice(0, SUMMARY_MAX) : '',
    openQuestions: Array.isArray(o.openQuestions) ? questions(o.openQuestions) : [],
    commitments: Array.isArray(o.commitments) ? commitments(o.commitments) : [],
  }
}

export const isEmptyMemory = (m: OleCallMemory) => !m.summary.trim() && !m.openQuestions.length && !m.commitments.length

const commitmentLine = (c: OleCommitment) => c.who ? `${c.who}: ${c.what}` : c.what

/** the record as the bullets and Ask prompts take it (#82): the summary text, then the two short lists */
export function callMemoryText(m: OleCallMemory): string {
  const parts: string[] = []
  if (m.summary.trim()) parts.push(m.summary.trim())
  if (m.openQuestions.length) parts.push(`Open questions:\n${m.openQuestions.map(q => `- ${q}`).join('\n')}`)
  if (m.commitments.length) parts.push(`Commitments:\n${m.commitments.map(c => `- ${commitmentLine(c)}`).join('\n')}`)
  return parts.join('\n\n')
}

/** an answer worth keeping in the notes: answered, not the "couldn't find it" or a failure */
const answered = (a: OleAnswer) => !a.pending && !!a.text.trim() && !/^Couldn['’]t (?:find that|answer)\b/.test(a.text)

/**
 * The "From Ole" notes section a finished call adds to the meeting's notes (#83): the running summary, open
 * questions, commitments and the questions asked with their answers, oldest first. '' when there is nothing.
 */
export function fromOleNotes(m: OleCallMemory, answers: OleAnswer[] = []): string {
  const parts: string[] = []
  if (m.summary.trim()) parts.push(m.summary.trim())
  if (m.openQuestions.length) parts.push(`**Open questions**\n${m.openQuestions.map(q => `- ${q}`).join('\n')}`)
  if (m.commitments.length) parts.push(`**Commitments**\n${m.commitments.map(c => `- ${commitmentLine(c)}`).join('\n')}`)
  const asked = answers.filter(answered).sort((a, b) => a.at - b.at)
  if (asked.length) parts.push(`**Asked during the call**\n${asked.map(a => `- ${a.question.replace(/\s+/g, ' ').trim()}: ${a.text.replace(/\s+/g, ' ').trim()}${a.source ? ` (${a.source})` : ''}`).join('\n')}`)
  return parts.length ? `## From Ole\n${parts.join('\n\n')}` : ''
}

export function createCallSummarizer(o: { chat: ChatFn; now?: () => number; everyMs?: number; onChange?: (m: OleCallMemory) => void }): {
  push(line: TranscriptLine): void
  /** the summary text with the open questions and commitments, for the prompts (#82) */
  summary(): string
  memory(): OleCallMemory
  stop(): void
} {
  const now = o.now ?? Date.now
  const every = o.everyMs ?? SUMMARY_EVERY_MS
  let pending: TranscriptLine[] = []
  let current: OleCallMemory = EMPTY_MEMORY
  let lastAt = now()
  let running = false, stopped = false

  const update = async () => {
    running = true
    const lines = pending
    pending = []
    lastAt = now()
    try {
      const before = current
      const reply = await o.chat({ messages: [
        { role: 'system', content: SUMMARY_SYSTEM },
        { role: 'user', content: [
          `Summary so far:\n${before.summary || '(none yet)'}`,
          `Open questions so far:\n${before.openQuestions.length ? before.openQuestions.map(q => `- ${q}`).join('\n') : '(none)'}`,
          `Commitments so far:\n${before.commitments.length ? before.commitments.map(c => `- ${commitmentLine(c)}`).join('\n') : '(none)'}`,
          `Newest part of the call:\n${lines.map(l => `[${clock(l.startMs)}] ${l.speaker}: ${l.text}`).join('\n')}`,
        ].join('\n\n') },
      ], response_format: { type: 'json_object' } })
      const next = parseCallMemory(reply.content, before)
      // not a record: keep the last one, and these lines go into the next update
      if (!next) throw new Error('unreadable summary')
      if (!stopped) { current = next; o.onChange?.(current) }
    } catch {
      // a failed update keeps the last record; these lines are folded into the next one
      if (!stopped) pending = [...lines, ...pending].slice(-400)
    } finally {
      running = false
    }
  }

  return {
    push(line) {
      if (stopped || !line.text.trim()) return
      pending.push(line)
      if (pending.length > 400) pending.splice(0, pending.length - 400)
      if (!running && now() - lastAt >= every) void update()
    },
    summary: () => callMemoryText(current),
    memory: () => current,
    stop() { stopped = true },
  }
}
