// Ole: a running summary of the call (#75), so live bullets and Ask keep what was discussed beyond the last few
// minutes. Updated in the background from the previous state and only the lines since, never blocking a turn.
// Structured (#82): the summary text, the questions raised and still open, and the commitments (who will do what),
// each marked done once the call shows it carried out (#158).
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
  '{"summary":"...","openQuestions":["..."],"commitments":[{"who":"...","what":"...","done":false}]}',
  '"summary": plain short lines, about 150 words at most. Keep topics discussed, decisions and names of things (products, features, numbers, dates). Drop small talk.',
  '"openQuestions": questions raised on the call that are still unanswered, each one short line. Drop a question once it has been answered.',
  '"commitments": what someone on the call said they will do. "who" is the person or side as the call names them ("Me" for the user), "what" one short line. Return every earlier commitment, in the same words. If the call clearly takes one back, return it with "withdrawn": true.',
  '"done": true only when the newest part of the call shows the commitment was actually carried out on the call (it was shown, sent, answered or done while everyone was there), otherwise false. Never guess and never mark one done because it was only discussed or promised again. A commitment already marked done stays done unless the conversation clearly reopens it. Return every earlier commitment with its done flag.',
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
    // only a real true is done (#158): a missing, string or other flag reads as open
    seen.add(key); out.push(o?.done === true ? { who, what, done: true } : { who, what })
    // the reply may run past the cap (old ones plus new); mergeCommitments applies the cap (#160)
    if (out.length === LIST_MAX * 2) break
  }
  return out
}

/** the same commitment across updates: its words, case, spacing and punctuation aside (the model may name who differently) */
const sameWhat = (c: OleCommitment) => c.what.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/**
 * The reply's commitments against the previous ones (#158): a previous commitment the reply left out is kept as it
 * was, never silently dropped; one the reply carries without a done flag keeps its done (only an explicit false
 * reopens it). Under the cap, new commitments give way to kept ones.
 */
function mergeCommitments(reply: OleCommitment[], previous: OleCommitment[], raw: unknown[]): OleCommitment[] {
  const whoOf = (c: { who: string }) => c.who.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  // what the raw reply said about each item: an explicit done flag, and whether it was taken back (#160)
  const rawInfo = raw.map(item => {
    const o = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : null
    return o ? { who: whoOf({ who: line(o.who) }), what: sameWhat({ who: '', what: clip(line(o.what), ITEM_MAX) }), flagged: typeof o.done === 'boolean', withdrawn: o.withdrawn === true } : null
  }).filter((x): x is NonNullable<typeof x> => !!x)
  const infoFor = (c: OleCommitment) => rawInfo.find(r => r.what === sameWhat(c) && r.who === whoOf(c)) ?? rawInfo.find(r => r.what === sameWhat(c))
  // match by who and what; by what alone only when exactly one earlier commitment has those words (#160)
  const used = new Set<number>()
  const find = (c: OleCommitment): number => {
    const w = sameWhat(c), who = whoOf(c)
    if (who) { const i = previous.findIndex((p, j) => !used.has(j) && sameWhat(p) === w && whoOf(p) === who); if (i >= 0) return i }
    const same = previous.map((_, j) => j).filter(j => !used.has(j) && sameWhat(previous[j]) === w)
    return same.length === 1 ? same[0] : -1
  }
  // the reply's order, then what it left out
  const out: Array<{ c: OleCommitment; fresh: boolean }> = []
  for (const c of reply) {
    const info = infoFor(c)
    const i = find(c)
    if (i < 0) { if (!info?.withdrawn) out.push({ c, fresh: true }); continue }
    used.add(i)
    if (info?.withdrawn) continue
    const prev = previous[i]
    // one the reply carries without a done flag keeps its done; only an explicit false reopens it (#158)
    out.push({ c: !info?.flagged && prev.done && !c.done ? { ...c, done: true } : c, fresh: false })
  }
  // a previous commitment the reply left out is kept as it was, never silently dropped (#158)
  for (let j = 0; j < previous.length; j++) if (!used.has(j)) out.push({ c: previous[j], fresh: false })
  // at the cap, done commitments (oldest first) make room for new ones before any open one is dropped (#160)
  const freshCount = () => out.filter(o => o.fresh).length
  while (out.length > LIST_MAX && freshCount() > 0) {
    const d = out.findIndex(o => !o.fresh && o.c.done)
    if (d < 0) break
    out.splice(d, 1)
  }
  // still over: the newest additions give way
  let room = LIST_MAX - out.filter(o => !o.fresh).length
  return out.filter(o => !o.fresh || room-- > 0).map(o => o.c)
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
    commitments: Array.isArray(o.commitments) ? mergeCommitments(commitments(o.commitments), previous.commitments, o.commitments) : previous.commitments,
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
const open = (m: OleCallMemory) => m.commitments.filter(c => !c.done)
const done = (m: OleCallMemory) => m.commitments.filter(c => c.done)

/** the record as the bullets and Ask prompts take it (#82): the summary text, then the short lists (done apart, #158) */
export function callMemoryText(m: OleCallMemory): string {
  const parts: string[] = []
  if (m.summary.trim()) parts.push(m.summary.trim())
  if (m.openQuestions.length) parts.push(`Open questions:\n${m.openQuestions.map(q => `- ${q}`).join('\n')}`)
  if (open(m).length) parts.push(`Commitments:\n${open(m).map(c => `- ${commitmentLine(c)}`).join('\n')}`)
  if (done(m).length) parts.push(`Done during the call:\n${done(m).map(c => `- ${commitmentLine(c)}`).join('\n')}`)
  return parts.join('\n\n')
}

/** an answer worth keeping in the notes: answered, not the "couldn't find it" or a failure. The ok flag decides; an
 * answer saved before it existed is judged by its text, as it was then */
const answered = (a: OleAnswer) => !a.pending && !!a.text.trim() && (a.ok ?? !/^Couldn['’]t (?:find that|answer)\b/.test(a.text))

/** a question and an answer in the notes are cut to these */
export const NOTE_QUESTION_MAX = 200
export const NOTE_ANSWER_MAX = 300

/**
 * Call content as one line of the notes: line breaks flattened, markdown control at its start taken off (headings,
 * quotes, list markers, code fences) and no bold of its own, so what was said on the call can't forge the section's
 * own headings, lists or labels.
 */
export function noteItem(v: string, max?: number): string {
  let s = v.replace(/\s+/g, ' ').replace(/\*\*/g, '').replace(/`{3,}/g, '').trim()
  for (;;) {
    const next = s.replace(/^(?:#+(?=\s|$)|>+|[-*+](?=\s|$)|\d+[.)](?=\s|$)|`+)\s*/, '').trim()
    if (next === s) break
    s = next
  }
  return max ? clip(s, max) : s
}

/**
 * The "From Ole" notes section a finished call adds to the meeting's notes (#83): the running summary, open
 * questions, the commitments still open, those done during the call (#158, so next steps don't repeat them) and the
 * questions asked with their answers, oldest first. '' when there is nothing; an empty part is left out.
 */
export function fromOleNotes(m: OleCallMemory, answers: OleAnswer[] = []): string {
  const parts: string[] = []
  // every item from the call is one flat line (noteItem): only Ole writes this section's structure
  const summary = m.summary.split('\n').map(l => noteItem(l)).filter(Boolean)
  if (summary.length) parts.push(summary.join('\n'))
  const questions = m.openQuestions.map(q => noteItem(q)).filter(Boolean)
  if (questions.length) parts.push(`**Open questions**\n${questions.map(q => `- ${q}`).join('\n')}`)
  const flat = (cs: OleCommitment[]) => cs.map(c => ({ who: noteItem(c.who), what: noteItem(c.what) })).filter(c => c.what)
  const promised = flat(open(m)), kept = flat(done(m))
  if (promised.length) parts.push(`**Commitments**\n${promised.map(c => `- ${commitmentLine(c)}`).join('\n')}`)
  if (kept.length) parts.push(`**Done during the call**\n${kept.map(c => `- ${commitmentLine(c)}`).join('\n')}`)
  const asked = answers.filter(answered).sort((a, b) => a.at - b.at).map(a => ({ q: noteItem(a.question, NOTE_QUESTION_MAX), text: noteItem(a.text, NOTE_ANSWER_MAX), source: a.source ? noteItem(a.source) : '' })).filter(a => a.q && a.text)
  if (asked.length) parts.push(`**Asked during the call**\n${asked.map(a => `- ${a.q}: ${a.text}${a.source ? ` (${a.source})` : ''}`).join('\n')}`)
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
          // as JSON with the flag (#158), so the reply can carry each one back in the same words and shape
          `Commitments so far:\n${before.commitments.length ? JSON.stringify(before.commitments.map(c => ({ who: c.who, what: c.what, done: !!c.done }))) : '(none)'}`,
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
