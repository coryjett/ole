// The meetings server as Yogurt's calendar when the Mac's has none (#149)
import { describe, expect, it, vi } from 'vitest'
import type { CalEvent, CalendarSource, CalendarStatus } from '../../src/main/calendar'
import { createMeetingSource, type Meeting, type ServerMeetings } from '../../src/main/ole/core/meetingSource'
import type { OleTool } from '../../src/main/ole/core/types'
import { createServerCalendar, MAC_CALENDARS_TTL_MS, SERVER_CALENDAR_ID, serverEvent } from '../../src/main/ole/yogurt/serverCalendar'

const T0 = Date.parse('2026-11-20T15:00:00Z')
const HOUR = 3600_000
const meeting = (o: Partial<Meeting> = {}): Meeting => ({ id: 'srv:1', title: 'Weekly sync', start: T0, end: T0 + HOUR, source: 'Meetings', ...o })
const macEvent: CalEvent = { id: 'mac-1', title: 'Mac meeting', start: T0, end: T0 + HOUR, attendees: [], url: null }
const work: CalendarSource = { id: 'work', name: 'Work', source: 'iCloud' }

function setup(o: { status?: CalendarStatus; calendars?: CalendarSource[]; events?: CalEvent[]; server?: ServerMeetings | null | Error; hide?: boolean } = {}) {
  let t = T0
  const mac = vi.fn(async () => o.events ?? [])
  const calendars = vi.fn(async () => o.calendars ?? [])
  const server = vi.fn(async () => { if (o.server instanceof Error) throw o.server; return o.server === undefined ? { serverName: 'Meetings', meetings: [meeting()] } : o.server })
  const cal = createServerCalendar({ mac, status: () => o.status ?? 'denied', calendars, server, hideWithoutLink: () => !!o.hide, now: () => t })
  return { cal, mac, calendars, server, advance: (ms: number) => { t += ms } }
}

describe('when the Mac calendar has nothing, the meetings server is the calendar', () => {
  it('no calendar access: the server list, named for its server', async () => {
    const { cal, calendars } = setup({ status: 'denied' })
    const read = await cal.read(T0, T0 + HOUR)
    expect(read.server).toBe('Meetings')
    expect(read.events).toEqual([serverEvent(meeting(), 'Meetings')])
    expect(calendars).not.toHaveBeenCalled()
  })

  it('access but no calendars (and no calendar link): the server list too', async () => {
    for (const status of ['granted', 'notDetermined', 'unsupported', 'error'] as const) {
      const { cal } = setup({ status, calendars: [] })
      expect((await cal.read(T0, T0 + HOUR)).server).toBe('Meetings')
    }
  })

  it('a server that fails, or none offering a list: no meetings, never a crash', async () => {
    for (const server of [null, new Error('down')]) {
      const { cal } = setup({ status: 'denied', server })
      expect(await cal.read(T0, T0 + HOUR)).toEqual({ events: [], server: null })
    }
  })
})

describe('when the Mac calendar has calendars, it stays the only source', () => {
  it('events on the Mac: those alone, the server never asked', async () => {
    const { cal, server } = setup({ status: 'granted', calendars: [work], events: [macEvent] })
    expect(await cal.read(T0, T0 + HOUR)).toEqual({ events: [macEvent], server: null })
    expect(server).not.toHaveBeenCalled()
  })

  it('a quiet day on a Mac with calendars: no meetings, no merging from the server', async () => {
    const { cal, server, calendars, advance } = setup({ status: 'granted', calendars: [work] })
    expect(await cal.read(T0, T0 + HOUR)).toEqual({ events: [], server: null })
    expect(await cal.read(T0, T0 + HOUR)).toEqual({ events: [], server: null })
    expect(server).not.toHaveBeenCalled()
    // whether the Mac has calendars is asked at most once a minute, or again after invalidate
    expect(calendars).toHaveBeenCalledTimes(1)
    advance(MAC_CALENDARS_TTL_MS + 1); await cal.read(T0, T0 + HOUR)
    cal.invalidate(); await cal.read(T0, T0 + HOUR)
    expect(calendars).toHaveBeenCalledTimes(3)
  })

  it('Settings names the server only while it is the source', async () => {
    expect(await setup({ status: 'denied' }).cal.inUse()).toBe('Meetings')
    expect(await setup({ status: 'granted', calendars: [work] }).cal.inUse()).toBeNull()
    expect(await setup({ status: 'denied', server: null }).cal.inUse()).toBeNull()
  })
})

describe('mapping a server meeting to a Yogurt event', () => {
  it('prefixed id, title, times, no attendees, the server calendar', () => {
    expect(serverEvent(meeting({ attendees: 4 }), 'Meetings')).toEqual({
      id: 'ole-server:srv:1', title: 'Weekly sync', start: T0, end: T0 + HOUR, attendees: [], url: null,
      calendar: { id: SERVER_CALENDAR_ID, name: 'From Meetings', source: 'server' },
    })
  })

  it('the url is the meeting link only when it is an https call link', () => {
    expect(serverEvent(meeting({ link: 'https://example.zoom.us/j/123' }), 'M').url).toBe('https://example.zoom.us/j/123')
    expect(serverEvent(meeting({ link: 'http://example.zoom.us/j/123' }), 'M').url).toBeNull()
    expect(serverEvent(meeting({ link: 'https://docs.example.com/agenda' }), 'M').url).toBeNull()
  })

  it('Hide events without a call link applies to server meetings as to the Mac\'s', async () => {
    const withLink = meeting({ id: 'srv:2', link: 'https://meet.google.com/abc-defg-hij' })
    const { cal } = setup({ status: 'denied', hide: true, server: { serverName: 'M', meetings: [meeting(), withLink] } })
    expect((await cal.read(T0, T0 + HOUR)).events.map(e => e.id)).toEqual(['ole-server:srv:2'])
    // linking a recording to its event sees every event, as with the Mac calendar
    expect((await cal.read(T0, T0 + HOUR, 'link-event')).events).toHaveLength(2)
    expect((await cal.read(T0, T0 + HOUR, e => e.id === 'ole-server:srv:1')).events).toHaveLength(2)
  })
})

describe('no loop between the host calendar and the meetings server', () => {
  it('the server-only read never reaches the host calendar, even with every server failing', async () => {
    const tool: OleTool = { name: 'm__get_upcoming_meetings', serverId: 'm', serverName: 'Meetings', tool: 'get_upcoming_meetings', description: '', parameters: { type: 'object', properties: {} } }
    let reply = JSON.stringify([{ title: 'Weekly sync', start: '2026-11-20T15:00:00Z', end: '2026-11-20T16:00:00Z' }])
    // the host calendar Ole is given is the same reader the fallback sits behind: a loop would recurse here
    const hostCalendar = { upcoming: vi.fn(async (from: number, to: number) => (await cal.read(from, to)).events) }
    const src = createMeetingSource({ tools: () => [tool], call: async () => reply, calendar: hostCalendar, now: () => T0, warn: () => {} })
    const cal = createServerCalendar({ mac: async () => [], status: () => 'denied', calendars: async () => [], server: (f, t) => src.serverMeetings(f, t), hideWithoutLink: () => false })
    expect((await cal.read(T0, T0 + HOUR)).events.map(e => e.title)).toEqual(['Weekly sync'])
    reply = 'error: down'
    const failing = createMeetingSource({ tools: () => [tool], call: async () => reply, calendar: hostCalendar, now: () => T0, warn: () => {} })
    const cal2 = createServerCalendar({ mac: async () => [], status: () => 'denied', calendars: async () => [], server: (f, t) => failing.serverMeetings(f, t), hideWithoutLink: () => false })
    expect(await cal2.read(T0, T0 + HOUR)).toEqual({ events: [], server: null })
    expect(hostCalendar.upcoming).not.toHaveBeenCalled()
  })
})
