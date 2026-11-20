// Ole: where meetings come from (#98). The ONE place that decides which MCP server (or the host calendar) answers "what
// meetings are coming up" and "what is this meeting". Prepare, auto-prepare and the session call the MeetingSource
// interface and never pick a server themselves, so another design (a dedicated meetings server, per-server roles)
// replaces only this module. See OLE.md "Meetings from your MCP servers".
//
// Today's design: the order of the servers in Settings is the priority.
// - meetingContext: get_meeting_context on each enabled server offering it, in order; the first result with
//   `matchedBy` set wins. An error, a timeout (8 s each) or a result without a match moves on to the next server.
// - upcomingMeetings: the first server, in order, whose get_upcoming_meetings succeeds supplies the list; with none,
//   the host calendar. Cached for a few minutes.
import type { OleTool } from './types'
import { eventNow, type Upcoming } from './calendarMatch'
import { MEETING_CONTEXT_TOOL } from './tools'

/** a meeting in the list, as the host calendar or a server gives it; the optional fields come from a server only */
export type Meeting = Upcoming & {
  attendees?: number
  /** the meeting's join link (https) */
  link?: string
  /** the record the server matched the meeting to */
  recordId?: string
  /** the server's short note about the meeting: one line, capped (NOTE_MAX) */
  note?: string
  /** the server's name, when a server supplied it */
  source?: string
}

/** a server's answer to "what is this meeting": the call as the model would have made it, and the server's result */
export type MeetingContext = { tool: OleTool; serverName: string; argsJson: string; result: string }

export type MeetingQuery = { title: string | null; focus: string | null; startsAt: number | null }

/** the interface the rest of Ole uses */
export type MeetingSource = {
  /** meetings overlapping [fromMs, toMs]; [] when there are none or nothing can be read */
  upcomingMeetings(fromMs: number, toMs: number): Promise<Meeting[]>
  /**
   * the meeting on now (started or starting within the window, or in progress): from the meetings list, and when a
   * server's list has none, from the host calendar too, since a server's list may leave out meetings already started
   */
  meetingNow(atMs: number): Promise<Meeting | null>
  /**
   * the first server's matched context for this meeting, or null when none matched; allow, when given, leaves out the
   * tools it refuses (the #126 subject lookups send a heard name, so only tools allowed to receive names, #91)
   */
  meetingContext(q: MeetingQuery, o?: { allow?: (tool: OleTool) => boolean }): Promise<MeetingContext | null>
  /**
   * the meetings server's own list (#149): the first server whose get_upcoming_meetings succeeds, with its name, from
   * the same cache as upcomingMeetings. Never reads the host calendar, so the host may use it as its own calendar's
   * fallback without a loop. null when no server offers a list or all failed.
   */
  serverMeetings(fromMs: number, toMs: number): Promise<ServerMeetings | null>
}

/** a server's meeting list and the server's name (as Settings shows it) */
export type ServerMeetings = { serverName: string; meetings: Meeting[] }

export const UPCOMING_TOOL = 'get_upcoming_meetings'
/** one server's meeting-context call may take this long before the next server is tried */
export const MEETING_CONTEXT_TIMEOUT_MS = 8_000
export const UPCOMING_TIMEOUT_MS = 10_000
/** a server's meeting list is reused for this long */
export const UPCOMING_CACHE_MS = 3 * 60_000
/** a server's list is asked for at least this far ahead, so auto-prepare and the meeting on now share one call */
const AHEAD_MS = 24 * 60 * 60_000
export const NOTE_MAX = 200
export const NOTE_PREFIX = 'Note about this meeting from'
/** the one line a meeting's note becomes in Prepare's request and the bullets prompt */
export const noteLine = (n: { text: string; source?: string }) => `${NOTE_PREFIX} ${n.source || 'the calendar'}: ${cleanNote(n.text)}`

/**
 * A server's note made safe to put in a prompt: one line, markdown links and images reduced to their text, bare URLs
 * dropped, no leading markdown control (#, >, -, *) on any line, no "**", at most NOTE_MAX chars
 */
export function cleanNote(raw: string): string {
  const text = raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '')
    .split(/\r?\n/)
    .map(l => l.replace(/^\s*(?:[#>*+-]+\s*)+/, ''))
    .join(' ')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > NOTE_MAX ? `${text.slice(0, NOTE_MAX - 1)}…` : text
}
const DEFAULT_LENGTH_MS = 30 * 60_000

export type SourceCall = (name: string, argsJson: string, opts?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<string>

export function createMeetingSource(o: {
  /** the enabled servers' read-only tools, in Settings order; [] when the servers may not be used */
  tools: () => OleTool[] | Promise<OleTool[]>
  call: SourceCall
  /** the host calendar, the fallback when no server supplies meetings */
  calendar?: { upcoming(fromMs: number, toMs: number): Promise<Upcoming[]> }
  now?: () => number
  /** the #93 failure line, one per server that failed */
  log?: (line: string) => void
  warn?: (message: string, error?: unknown) => void
  contextTimeoutMs?: number
}): MeetingSource {
  const now = o.now ?? (() => Date.now())
  const log = o.log ?? ((line: string) => console.info(line))
  let cache: { at: number; to: number; key: string; list: ServerMeetings | null } | null = null

  const timed = async (p: Promise<string>, ms: number): Promise<string> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), ms) })])
    } finally { clearTimeout(timer) }
  }

  /** the first server whose list succeeds, or null when none offers one or all failed */
  async function fromServers(fromMs: number, toMs: number): Promise<ServerMeetings | null> {
    const offering = (await o.tools()).filter(t => t.tool === UPCOMING_TOOL)
    const key = offering.map(t => t.name).join('\n')
    const t = now()
    if (cache && cache.key === key && t - cache.at < UPCOMING_CACHE_MS && toMs <= cache.to) return cache.list
    if (!offering.length) { cache = null; return null }
    const to = Math.max(toMs, t + AHEAD_MS)
    let found: ServerMeetings | null = null
    for (const tool of offering) {
      try {
        const result = await timed(o.call(tool.name, JSON.stringify(upcomingArgs(tool, t, to)), { timeoutMs: UPCOMING_TIMEOUT_MS }), UPCOMING_TIMEOUT_MS)
        const list = parseMeetings(result, tool.serverId, tool.serverName)
        if (list) { found = { serverName: tool.serverName, meetings: list }; break }
      } catch (e) { o.warn?.(`reading meetings from ${tool.serverName} failed`, e) }
    }
    cache = { at: t, to, key, list: found }
    return found
  }
  const within = (list: Meeting[], fromMs: number, toMs: number) => list.filter(m => m.end > fromMs && m.start < toMs)

  return {
    async upcomingMeetings(fromMs, toMs) {
      const servers = await fromServers(fromMs, toMs)
      if (servers) return within(servers.meetings, fromMs, toMs)
      if (!o.calendar) return []
      return o.calendar.upcoming(fromMs, toMs)
    },

    async meetingNow(atMs) {
      const from = atMs - 12 * 60 * 60_000, to = atMs + 60 * 60_000
      const servers = await fromServers(from, to)
      const found = eventNow(within(servers?.meetings ?? [], from, to), atMs)
      if (found || !o.calendar) return found
      return eventNow(await o.calendar.upcoming(from, to), atMs)
    },

    async meetingContext(q, opts) {
      const offering = (await o.tools()).filter(t => t.tool === MEETING_CONTEXT_TOOL && (!opts?.allow || opts.allow(t)))
      const ms = o.contextTimeoutMs ?? MEETING_CONTEXT_TIMEOUT_MS
      for (const tool of offering) {
        const argsJson = JSON.stringify(meetingContextArgs(tool, q))
        try {
          const result = await timed(o.call(tool.name, argsJson, { timeoutMs: ms }), ms)
          if (/^error:/.test(result)) throw new Error(result.slice(6).trim().slice(0, 120))
          if (serverMatched(result)) return { tool, serverName: tool.serverName, argsJson, result }
        } catch (e) {
          // a failure costs nothing: the next server, then the model's own loop
          log(`ole prepare: ${MEETING_CONTEXT_TOOL} on ${tool.serverName} failed (${failureKind(e)}), using the tool loop`)
        }
      }
      return null
    },

    async serverMeetings(fromMs, toMs) {
      const servers = await fromServers(fromMs, toMs)
      return servers && { serverName: servers.serverName, meetings: within(servers.meetings, fromMs, toMs) }
    },
  }
}

/** the kind of a fast-path failure for the log (#95): never the server's own message, which may carry URLs or ids */
export function failureKind(e: unknown): 'timeout' | 'transport' | 'server error' {
  const m = e instanceof Error ? e.message : String(e)
  if (/timed? ?out|timeout|abort/i.test(m)) return 'timeout'
  if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|network|socket|unreachable/i.test(m)) return 'transport'
  return 'server error'
}

/** a result that is a non-empty JSON object whose `matchedBy` is set: the server found the meeting's record (#93) */
export function serverMatched(result: string): boolean {
  let v: unknown
  try { v = JSON.parse(result) } catch { return false }
  if (!v || typeof v !== 'object' || Array.isArray(v) || !Object.keys(v).length) return false
  const by = (v as Record<string, unknown>).matchedBy
  return by !== null && by !== undefined && by !== false && by !== ''
}

const declaredOf = (tool: OleTool): Set<string> | null => {
  const props = tool.parameters?.properties
  return props && typeof props === 'object' && Object.keys(props).length ? new Set(Object.keys(props)) : null
}

/** the arguments a meeting-context tool gets: only known values, and only those its schema declares when it declares any */
export function meetingContextArgs(tool: OleTool, o: { title: string | null; focus: string | null; startsAt: number | null }): Record<string, string> {
  const known: Record<string, string | null> = {
    meeting_title: o.title,
    focus: o.focus,
    starts_at: o.startsAt !== null && Number.isFinite(o.startsAt) ? new Date(o.startsAt).toISOString() : null,
  }
  const declared = declaredOf(tool)
  const args: Record<string, string> = {}
  for (const [k, v] of Object.entries(known)) if (v && (!declared || declared.has(k))) args[k] = v
  return args
}

/** the window for a meetings list, in the argument names its schema declares (none: no arguments) */
export function upcomingArgs(tool: OleTool, fromMs: number, toMs: number): Record<string, string | number> {
  const declared = declaredOf(tool)
  if (!declared) return {}
  const from = new Date(fromMs).toISOString(), to = new Date(toMs).toISOString()
  const known: Record<string, string | number> = {
    from, to, start: from, end: to, time_min: from, time_max: to,
    days: Math.min(30, Math.max(1, Math.ceil((toMs - fromMs) / (24 * 60 * 60_000)))),
  }
  const args: Record<string, string | number> = {}
  for (const [k, v] of Object.entries(known)) if (declared.has(k)) args[k] = v
  return args
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : null
const first = (e: Record<string, unknown>, keys: string[]): unknown => { for (const k of keys) if (e[k] !== undefined && e[k] !== null && e[k] !== '') return e[k]; return undefined }

/** a time as ms: an ISO string, epoch ms, or a calendar-style { dateTime } / { date } */
function timeOf(v: unknown): number | null {
  if (isObject(v)) return timeOf(v.dateTime ?? v.date_time ?? v.date)
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v !== 'string' || !v.trim()) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

const oneLine = (s: string, max: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t }

/** one meeting from a server's result, mapped tolerantly; null when it has no title or start */
export function toMeeting(v: unknown, serverId: string, serverName: string): Meeting | null {
  if (!isObject(v)) return null
  const titleField = str(v.title) ?? str(v.subject) ?? str(v.name)
  const title = titleField ?? str(v.summary)
  const start = timeOf(first(v, ['start', 'startTime', 'start_time', 'startsAt', 'starts_at']))
  if (!title || start === null) return null
  const endRaw = timeOf(first(v, ['end', 'endTime', 'end_time', 'endsAt', 'ends_at']))
  const end = endRaw !== null && endRaw > start ? endRaw : start + DEFAULT_LENGTH_MS
  const rawId = str(first(v, ['id', 'eventId', 'event_id', 'meetingId', 'meeting_id']))
  const m: Meeting = { id: `${serverId}:${rawId ?? `${title}@${start}`}`, title: oneLine(title, 300), start, end, source: serverName }
  const count = first(v, ['attendeeCount', 'attendee_count', 'attendeesCount'])
  if (typeof count === 'number' && Number.isFinite(count) && count >= 0) m.attendees = Math.floor(count)
  else if (Array.isArray(v.attendees)) m.attendees = v.attendees.length
  const link = str(first(v, ['meetingLink', 'meeting_link', 'joinUrl', 'join_url', 'hangoutLink', 'link', 'url']))
  if (link && /^https:\/\/\S+$/.test(link) && link.length <= 500) m.link = link
  const account = isObject(v.account) ? v.account : isObject(v.matchedAccount) ? v.matchedAccount : null
  const recordId = str(first(v, ['matchedRecordId', 'matched_record_id', 'recordId', 'record_id', 'accountId', 'account_id'])) ?? (account ? str(account.id) : null)
  if (recordId) m.recordId = recordId.slice(0, 100)
  // `summary` is the note only when something else gave the title (calendar APIs use `summary` for the title)
  const noteRaw = str(first(v, ['aiSummary', 'ai_summary', 'note', 'notes', 'brief'])) ?? (titleField ? str(v.summary) : null)
  if (noteRaw) { const note = cleanNote(noteRaw); if (note) m.note = note }
  return m
}

const LIST_KEYS = ['meetings', 'events', 'items', 'upcoming', 'results', 'data']

/** a server's meetings list: a JSON array, or an object holding one; null when the result is not a list (a failure) */
export function parseMeetings(result: string, serverId: string, serverName: string): Meeting[] | null {
  if (/^error:/.test(result)) return null
  let v: unknown
  try { v = JSON.parse(result) } catch { return null }
  const list = Array.isArray(v) ? v : isObject(v) ? LIST_KEYS.map(k => v[k]).find(Array.isArray) : undefined
  if (!Array.isArray(list)) return null
  return list.map(e => toMeeting(e, serverId, serverName)).filter((m): m is Meeting => !!m)
}
