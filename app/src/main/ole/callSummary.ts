// Ole: a running summary of the call (#75), so live bullets and Ask keep what was discussed beyond the last few
// minutes. Updated in the background from the previous summary and only the lines since, never blocking a turn.
import type { ChatFn, TranscriptLine } from './bullets'

/** how much new conversation triggers an update */
export const SUMMARY_EVERY_MS = 3 * 60_000
/** the summary is kept to about this many characters */
export const SUMMARY_MAX = 1200

export const SUMMARY_SYSTEM = [
  'You keep a running summary of a live call for the user, who is on it.',
  'Given the summary so far and the newest part of the conversation, reply with the updated summary only: plain short lines, about 150 words at most.',
  'Keep: topics discussed, questions raised (answered or not), decisions, commitments and names of things (products, features, numbers, dates). Drop small talk.',
  'Never invent anything; when the new part adds nothing, return the summary unchanged.',
].join('\n')

const clock = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }

export function createCallSummarizer(o: { chat: ChatFn; now?: () => number; everyMs?: number }): {
  push(line: TranscriptLine): void; summary(): string; stop(): void
} {
  const now = o.now ?? Date.now
  const every = o.everyMs ?? SUMMARY_EVERY_MS
  let pending: TranscriptLine[] = []
  let current = ''
  let lastAt = now()
  let running = false, stopped = false

  const update = async () => {
    running = true
    const lines = pending
    pending = []
    lastAt = now()
    try {
      const reply = await o.chat({ messages: [
        { role: 'system', content: SUMMARY_SYSTEM },
        { role: 'user', content: `Summary so far:\n${current || '(none yet)'}\n\nNewest part of the call:\n${lines.map(l => `[${clock(l.startMs)}] ${l.speaker}: ${l.text}`).join('\n')}` },
      ] })
      const text = (reply.content ?? '').trim()
      if (!stopped && text) current = text.slice(0, SUMMARY_MAX)
    } catch {
      // a failed update keeps the last summary; these lines are folded into the next one
      if (!stopped) pending = [...lines, ...pending]
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
    summary: () => current,
    stop() { stopped = true },
  }
}
