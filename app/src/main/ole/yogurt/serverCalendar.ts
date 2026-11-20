// Ole on Yogurt: the meetings server as Yogurt's calendar when the Mac's has none (#149). Yogurt's calendar reads
// (the Agenda, coming up, start and prepare from an event, linking a recording to its event, call detection, the menu
// bar) go through index.ts's readCalendar; when the Mac calendar has no access or no calendars, they get the meetings
// server's list instead, mapped to Yogurt's event shape. When the Mac calendar has calendars it stays the only source:
// no merging, no duplicates. Read-only, and the server list comes from core meetingSource's server-only read, which
// never reads the host calendar, so there is no loop back into this module.
import { createHash } from 'node:crypto'
import type { CalEvent, CalendarSource, CalendarStatus } from '../../calendar'
import { meetingLink } from '../../calendar'
import type { Meeting, ServerMeetings } from '../core/meetingSource'

export const SERVER_CALENDAR_ID = 'ole-server'
/** server meeting ids are prefixed so they never clash with the Mac's own event ids */
export const SERVER_EVENT_PREFIX = 'ole-server:'
/** how long "the Mac has calendars" is reused, so a quiet day doesn't ask the Mac helper on every read */
export const MAC_CALENDARS_TTL_MS = 60_000

export const serverCalendar = (serverName: string): CalendarSource => ({ id: SERVER_CALENDAR_ID, name: `From ${serverName}`, source: 'server' })

/** one server meeting as a Yogurt event: no attendees (a server gives at most a count), a call link only when it is one */
/** a server's id never becomes part of a key as-is: a fixed-length hash of it (#152) */
const safeId = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 32)
/** titles without control or direction characters, capped (#152) */
const safeTitle = (t: string) => t.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200)

export function serverEvent(m: Meeting, serverName: string): CalEvent {
  const link = m.link && /^https:\/\//.test(m.link) ? meetingLink(m.link) : null
  return {
    id: `${SERVER_EVENT_PREFIX}${safeId(m.id)}`, title: safeTitle(m.title), start: m.start, end: m.end, attendees: [],
    url: link && /^https:\/\//.test(link) ? link : null, calendar: serverCalendar(serverName),
  }
}

export type CalendarRead = { events: CalEvent[]; server: string | null }
type Keep = 'link-event' | ((event: CalEvent) => boolean)

export function createServerCalendar(d: {
  /** the Mac calendar (and calendar links), as Yogurt reads it */
  mac: (fromMs: number, toMs: number, keep?: Keep) => Promise<CalEvent[]>
  /** calendar access as the last Mac read left it */
  status: () => CalendarStatus
  /** the calendars Yogurt can read; [] with no access */
  calendars: () => Promise<CalendarSource[]>
  /** the meetings server's own list (core session.serverMeetings); undefined before Ole is wired */
  server: (fromMs: number, toMs: number) => Promise<ServerMeetings | null>
  /** Settings > Calendars > Hide events without a call link */
  hideWithoutLink: () => boolean
  now?: () => number
}) {
  const now = d.now ?? (() => Date.now())
  let known: { at: number; has: boolean } | null = null

  /** the Mac (or a calendar link) has a calendar to read: then it is the only source */
  async function macHasCalendars(): Promise<boolean> {
    if (d.status() !== 'granted') return false
    const t = now()
    if (known && t - known.at < MAC_CALENDARS_TTL_MS) return known.has
    // a failed check isn't remembered as "no calendars": the next read tries again (#152)
    try { const has = (await d.calendars()).length > 0; known = { at: t, has }; return has } catch { return false }
  }

  /** the server's list, or null on any failure (the reader then shows what the Mac gave: nothing) */
  async function fromServer(fromMs: number, toMs: number): Promise<ServerMeetings | null> {
    try { return await d.server(fromMs, toMs) } catch { return null }
  }

  return {
    async read(fromMs: number, toMs: number, keep?: Keep): Promise<CalendarRead> {
      const events = await d.mac(fromMs, toMs, keep)
      if (events.length || await macHasCalendars()) return { events, server: null }
      const list = await fromServer(fromMs, toMs)
      if (!list) return { events, server: null }
      const mapped = list.meetings.map(m => serverEvent(m, list.serverName))
      const shown = keep === 'link-event' || !d.hideWithoutLink() ? mapped : mapped.filter(e => e.url !== null || (typeof keep === 'function' && keep(e)))
      return { events: shown, server: list.serverName }
    },
    /** the server whose meetings Yogurt shows (Settings > Calendars), or null while the Mac calendar is the source */
    async inUse(): Promise<string | null> {
      if (await macHasCalendars()) return null
      const t = now()
      return (await fromServer(t, t + 24 * 60 * 60_000))?.serverName ?? null
    },
    /** calendars changed (a link added, access granted): ask the Mac again on the next read */
    invalidate() { known = null },
  }
}
