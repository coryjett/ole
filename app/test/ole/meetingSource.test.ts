// Where meetings come from (#98): server order is the priority, the host calendar is the fallback.
import { describe, expect, it, vi } from 'vitest'
import { createMeetingSource, MEETING_CONTEXT_TIMEOUT_MS, noteLine, parseMeetings, toMeeting, UPCOMING_CACHE_MS, upcomingArgs } from '../../src/main/ole/core/meetingSource'
import type { OleTool } from '../../src/main/ole/core/types'

const tool = (serverId: string, name: string, properties: Record<string, unknown> = {}): OleTool =>
  ({ name: `${serverId}__${name}`, serverId, serverName: serverId.toUpperCase(), tool: name, description: name, parameters: { type: 'object', properties } })
const T0 = Date.parse('2026-11-20T15:00:00Z')
const MATCHED = (from: string) => JSON.stringify({ matchedBy: 'title', from })
const q = { title: 'Example Co sync', focus: null, startsAt: null }

describe('meetingContext: servers in order, the first match wins', () => {
  it('stops at the first server whose result has matchedBy set', async () => {
    const tools = [tool('a', 'get_meeting_context'), tool('b', 'get_meeting_context'), tool('c', 'get_meeting_context')]
    const call = vi.fn(async (name: string, _args?: string, _opts?: unknown) => name.startsWith('a') ? '{"matchedBy":null}' : MATCHED(name))
    const src = createMeetingSource({ tools: () => tools, call, log: () => {} })
    const got = await src.meetingContext(q)
    expect(got).toMatchObject({ serverName: 'B', result: MATCHED('b__get_meeting_context'), argsJson: '{"meeting_title":"Example Co sync"}' })
    expect(call.mock.calls.map(c => c[0])).toEqual(['a__get_meeting_context', 'b__get_meeting_context'])
    // each call carries the short per-server timeout to the tool runner
    expect(call.mock.calls[0][2]).toEqual({ timeoutMs: MEETING_CONTEXT_TIMEOUT_MS })
  })

  it('an error, a throw and a timeout each move on to the next server, with one log line each', async () => {
    vi.useFakeTimers()
    try {
      const tools = [tool('a', 'get_meeting_context'), tool('b', 'get_meeting_context'), tool('c', 'get_meeting_context'), tool('d', 'get_meeting_context')]
      const call = vi.fn((name: string) => name.startsWith('a') ? Promise.resolve('error: 500')
        : name.startsWith('b') ? Promise.reject(new Error('fetch failed'))
        : name.startsWith('c') ? new Promise<string>(() => {})
        : Promise.resolve(MATCHED('d')))
      const log = vi.fn()
      const done = createMeetingSource({ tools: () => tools, call, log }).meetingContext(q)
      await vi.advanceTimersByTimeAsync(MEETING_CONTEXT_TIMEOUT_MS + 1)
      expect((await done)?.serverName).toBe('D')
      expect(log.mock.calls.map(c => c[0])).toEqual([
        'ole prepare: get_meeting_context on A failed (server error), using the tool loop',
        'ole prepare: get_meeting_context on B failed (transport), using the tool loop',
        'ole prepare: get_meeting_context on C failed (timeout), using the tool loop',
      ])
    } finally { vi.useRealTimers() }
  })

  it('null when no server matches or none offers the tool', async () => {
    const call = vi.fn(async () => '{"account":{"name":"x"}}')
    expect(await createMeetingSource({ tools: () => [tool('a', 'get_meeting_context')], call }).meetingContext(q)).toBeNull()
    expect(await createMeetingSource({ tools: () => [tool('a', 'search_accounts')], call }).meetingContext(q)).toBeNull()
    expect(call).toHaveBeenCalledTimes(1)
  })
})

describe('upcomingMeetings: the first server that succeeds, else the host calendar', () => {
  const list = (title: string) => JSON.stringify({ meetings: [{ title, startTime: '2026-11-20T15:30:00Z', endTime: '2026-11-20T16:00:00Z' }] })

  it('takes the list from the first server in order whose call succeeds', async () => {
    const tools = [tool('a', 'get_upcoming_meetings'), tool('b', 'get_upcoming_meetings'), tool('c', 'get_upcoming_meetings')]
    const call = vi.fn(async (name: string) => name.startsWith('a') ? 'error: down' : name.startsWith('b') ? list('From B') : list('From C'))
    const calendar = { upcoming: vi.fn(async () => []) }
    const got = await createMeetingSource({ tools: () => tools, call, calendar, now: () => T0 }).upcomingMeetings(T0, T0 + 3600_000)
    expect(got.map(m => [m.title, m.source])).toEqual([['From B', 'B']])
    expect(call.mock.calls.map(c => c[0])).toEqual(['a__get_upcoming_meetings', 'b__get_upcoming_meetings'])
    expect(calendar.upcoming).not.toHaveBeenCalled()
  })

  it('a server that succeeds with no meetings is still the source', async () => {
    const calendar = { upcoming: vi.fn(async () => [{ id: 'h', title: 'Host', start: T0, end: T0 + 1 }]) }
    const got = await createMeetingSource({ tools: () => [tool('a', 'get_upcoming_meetings')], call: async () => '[]', calendar, now: () => T0 }).upcomingMeetings(T0, T0 + 3600_000)
    expect(got).toEqual([])
    expect(calendar.upcoming).not.toHaveBeenCalled()
  })

  it('falls back to the host calendar when every server fails, unparseable included, or none offers a list', async () => {
    const host = [{ id: 'h', title: 'Host meeting', start: T0, end: T0 + 1800_000 }]
    const calendar = { upcoming: vi.fn(async () => host) }
    const failing = createMeetingSource({ tools: () => [tool('a', 'get_upcoming_meetings'), tool('b', 'get_upcoming_meetings')], call: async (n) => n.startsWith('a') ? 'not json' : 'error: x', calendar, now: () => T0 })
    expect(await failing.upcomingMeetings(T0, T0 + 1)).toEqual(host)
    const none = createMeetingSource({ tools: () => [tool('a', 'search_accounts')], call: vi.fn(), calendar, now: () => T0 })
    expect(await none.upcomingMeetings(T0, T0 + 1)).toEqual(host)
    expect(await createMeetingSource({ tools: () => [], call: vi.fn() }).upcomingMeetings(T0, T0 + 1)).toEqual([])
  })

  it('caches a server list for a few minutes and filters it to the window asked', async () => {
    let t = T0
    const call = vi.fn(async () => JSON.stringify([
      { id: '1', title: 'Soon', start: '2026-11-20T15:10:00Z', end: '2026-11-20T15:40:00Z' },
      { id: '2', title: 'Later', start: '2026-11-20T20:00:00Z', end: '2026-11-20T21:00:00Z' },
    ]))
    const src = createMeetingSource({ tools: () => [tool('a', 'get_upcoming_meetings')], call, now: () => t })
    expect((await src.upcomingMeetings(T0, T0 + 15 * 60_000)).map(m => m.title)).toEqual(['Soon'])
    expect((await src.upcomingMeetings(T0, T0 + 6 * 3600_000)).map(m => m.title)).toEqual(['Soon', 'Later'])
    expect(call).toHaveBeenCalledTimes(1)
    t += UPCOMING_CACHE_MS + 1
    await src.upcomingMeetings(t, t + 60_000)
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('sends the window only in argument names the schema declares', () => {
    expect(upcomingArgs(tool('a', 'get_upcoming_meetings'), T0, T0 + 86_400_000)).toEqual({})
    expect(upcomingArgs(tool('a', 'get_upcoming_meetings', { days: {} }), T0, T0 + 1.5 * 86_400_000)).toEqual({ days: 2 })
    expect(upcomingArgs(tool('a', 'get_upcoming_meetings', { from: {}, to: {} }), T0, T0 + 1000)).toEqual({ from: '2026-11-20T15:00:00.000Z', to: '2026-11-20T15:00:01.000Z' })
  })
})

describe('tolerant mapping of a server meeting', () => {
  it('reads the common field names', () => {
    const m = toMeeting({ id: 'm1', summary: 'Example Co sync', start: { dateTime: '2026-11-20T15:30:00Z' }, end: '2026-11-20T16:00:00Z', attendees: [{}, {}, {}], hangoutLink: 'https://meet.example.com/x', accountId: 'acc-1', aiSummary: 'Renewal\n is  due' }, 'a', 'A')!
    expect(m).toEqual({ id: 'a:m1', title: 'Example Co sync', start: Date.parse('2026-11-20T15:30:00Z'), end: Date.parse('2026-11-20T16:00:00Z'), source: 'A', attendees: 3, link: 'https://meet.example.com/x', recordId: 'acc-1', note: 'Renewal is due' })
  })

  it('summary is the note when a title is given; a missing end lasts 30 minutes; a bad link is dropped', () => {
    const m = toMeeting({ title: 'Sync', startTime: '2026-11-20T15:30:00Z', summary: 'x'.repeat(500), attendeeCount: 4, meetingLink: 'javascript:alert(1)', account: { id: 'r9' } }, 'a', 'A')!
    expect(m.title).toBe('Sync')
    expect(m.end - m.start).toBe(30 * 60_000)
    expect(m.note!.length).toBe(200)
    expect(m.attendees).toBe(4)
    expect(m.link).toBeUndefined()
    expect(m.recordId).toBe('r9')
    expect(m.id).toBe(`a:Sync@${m.start}`)
  })

  it('drops entries without a title or start, and refuses a result that is not a list', () => {
    expect(parseMeetings(JSON.stringify({ events: [{ title: 'ok', start: '2026-11-20T15:30:00Z' }, { title: 'no start' }, { start: '2026-11-20T15:30:00Z' }, 'x'] }), 'a', 'A')!.map(m => m.title)).toEqual(['ok'])
    expect(parseMeetings('{"error":"nope"}', 'a', 'A')).toBeNull()
    expect(parseMeetings('error: down', 'a', 'A')).toBeNull()
  })

  it('a note becomes one line naming its server', () => {
    expect(noteLine({ text: 'Renewal is due', source: 'CRM' })).toBe('Note about this meeting from CRM: Renewal is due')
  })
})
