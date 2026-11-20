// Ole: a saved meeting as a replay fixture (#70), in the format of the dev replay harness (#66, replayFormat.ts).
// Pure: the session reads the meeting, the briefing and the recorded turns, this builds the file's content.
import type { ReplayFixture, ReplayReply, ReplayToolCall } from './replayFormat'
import type { RecordedTurn } from './turnRecorder'
import { genericTitle } from '../titles'

/** a transcript line as Yogurt's store keeps it */
export type ExportSegment = { track: 'me' | 'them'; speaker?: string | null; text: string; startMs: number; endMs?: number }

export type ExportInput = {
  /** the fixture's name */
  name: string
  meetingTitle: string
  /** the calendar attendees' names (and addresses), for anonymising */
  attendees?: Array<{ name: string; email?: string | null }>
  segments: ExportSegment[]
  briefing: { text: string; meetingTitle?: string | null; focus?: string | null }
  /** tool names offered to the model, `<server>__<tool>` */
  tools: string[]
  /** the recorded bullets turns; none for a call recorded before they were kept (the fixture is then for --live) */
  turns?: RecordedTurn[]
  anonymise?: boolean
}

/** labels the live engine itself gives a line with no name; they name nobody, so anonymising keeps them */
const GENERIC_SPEAKERS = new Set(['me', 'them', 'you'])
/** what separates the account from the topic in a meeting title: "Acme: security review", "Acme <> Us", "Acme - sync" */
const TITLE_SEPARATOR = /\s*(?::|\||<>|\s[-–—x]\s|\/\/)\s*/i
const LINK = /\bhttps?:\/\/[^\s"'<>()[\]{}\\]+/gi
const EMAIL = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const lineSpeaker = (s: ExportSegment) => s.speaker?.trim() || (s.track === 'me' ? 'Me' : 'Them')

/** the account a meeting title names, when it has one before a separator; null when that can't be told */
export function accountFromTitle(title: string): string | null {
  const parts = title.split(TITLE_SEPARATOR).map(p => p.trim()).filter(Boolean)
  if (parts.length < 2) return null
  const first = parts[0]
  return first.length >= 2 && first.length <= 60 && !GENERIC_SPEAKERS.has(first.toLowerCase()) ? first : null
}

/**
 * The replacements anonymising makes, longest first. Speakers and attendees become "Speaker 1", "Speaker 2"… in order
 * of first appearance (full name, and each part of it of 3+ letters, matched as whole words with their capital letter);
 * every link becomes https://example.com/link-N (the same link, the same N) and every email address "[email]";
 * the meeting title (unless it is a default one like "Meeting") and the account before its separator become "Account".
 */
export function anonymiser(o: { meetingTitle: string; briefingTitle?: string | null; speakers: string[]; attendees: string[] }): {
  speaker(name: string): string
  text(s: string): string
} {
  const labels = new Map<string, string>()
  const label = (name: string) => {
    const k = name.trim().toLowerCase()
    if (!k || GENERIC_SPEAKERS.has(k)) return null
    if (!labels.has(k)) labels.set(k, `Speaker ${labels.size + 1}`)
    return labels.get(k)!
  }
  const rules: Array<{ re: RegExp; to: string; len: number }> = []
  const add = (from: string, to: string, flags: string) => {
    const f = from.trim()
    if (f.length >= 2) rules.push({ re: new RegExp(`(?<![\\w])${escape(f)}(?![\\w])`, flags), to, len: f.length })
  }
  for (const name of [...o.speakers, ...o.attendees]) {
    const to = label(name)
    if (!to) continue
    add(name, to, 'gi')
    const parts = name.trim().split(/\s+/)
    if (parts.length > 1) for (const p of parts) if (/^\p{L}{3,}$/u.test(p)) add(p, to, 'g')
  }
  for (const t of [o.meetingTitle, o.briefingTitle ?? '']) {
    // "Meeting", "Zoom call": a default title names nothing, and replacing it would rewrite ordinary words
    if (!t.trim() || genericTitle(t)) continue
    add(t, 'Account', 'gi')
    const account = accountFromTitle(t)
    if (account) add(account, 'Account', 'gi')
  }
  rules.sort((a, b) => b.len - a.len)
  // each distinct link becomes its own example.com placeholder, so a bullet's link still matches the result it came from
  const links = new Map<string, string>()
  const link = (match: string) => {
    const url = match.replace(/[.,;:!?]+$/, ''), rest = match.slice(url.length)
    if (!links.has(url)) links.set(url, `https://example.com/link-${links.size + 1}`)
    return links.get(url)! + rest
  }
  return {
    speaker: (name) => label(name) ?? name,
    text: (s) => rules.reduce((t, r) => t.replace(r.re, r.to), s.replace(EMAIL, '[email]').replace(LINK, link)),
  }
}

/** a recorded turn as the harness reads it: the replies in order, each with its own latency */
const toReply = (r: RecordedTurn['replies'][number], text: (s: string) => string): ReplayReply => ({
  ...(r.content !== undefined ? { content: r.content === null ? null : text(r.content) } : {}),
  ...(r.toolCalls?.length ? { toolCalls: r.toolCalls.map((c): ReplayToolCall => ({
    name: c.name,
    ...(c.arguments ? { arguments: mapStrings(c.arguments, text) as Record<string, unknown> } : {}),
    ...(c.result !== undefined ? { result: text(c.result) } : {}),
  })) } : {}),
  ...(r.error !== undefined ? { error: r.error } : {}),
  latencyMs: r.latencyMs,
})

const mapStrings = (v: unknown, f: (s: string) => string): unknown =>
  typeof v === 'string' ? f(v) : Array.isArray(v) ? v.map(x => mapStrings(x, f))
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, f)])) : v

/**
 * The replay fixture for a saved call. Anonymised, the same replacements run over every text in it (transcript,
 * briefing, replies, lookup arguments and results), so what the engine checks against still matches.
 */
export function buildReplayFixture(i: ExportInput): ReplayFixture {
  const lines = i.segments.filter(s => s.text.trim()).sort((a, b) => a.startMs - b.startMs)
  const speakers = [...new Set(lines.map(lineSpeaker))]
  const anon = i.anonymise ? anonymiser({ meetingTitle: i.meetingTitle, briefingTitle: i.briefing.meetingTitle, speakers, attendees: (i.attendees ?? []).map(a => a.name) }) : null
  const text = anon ? anon.text : (s: string) => s
  const ends = lines.map(s => s.endMs ?? s.startMs)
  const endMs = ends.length ? Math.max(...ends) : undefined
  const briefingTitle = i.briefing.meetingTitle ?? null
  return {
    name: i.name,
    briefing: {
      meetingTitle: briefingTitle === null ? null : text(briefingTitle),
      focus: i.briefing.focus == null ? null : text(i.briefing.focus),
      text: text(i.briefing.text),
    },
    tools: [...i.tools],
    transcript: lines.map(s => ({ speaker: anon ? anon.speaker(lineSpeaker(s)) : lineSpeaker(s), text: text(s.text), startMs: s.startMs })),
    turns: (i.turns ?? []).map(t => ({ replies: t.replies.map(r => toReply(r, text)) })),
    ...(endMs !== undefined && endMs > 0 ? { endMs } : {}),
  }
}

/** the file name the save panel suggests: ole-replay-2026-11-20.json */
export function exportFileName(at: number): string {
  const d = new Date(at)
  return `ole-replay-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json`
}
