// #126, #142: Home shows the next meeting and the state of its briefing from Ole's own Prepare: when auto-prepare
// will run, preparing, briefing ready or no match; and Prepare now.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OleHost, OleSettings } from '../../src/main/ole/core/host'
import type { SecretName } from '../../src/main/ole/core/types'
import type { Upcoming } from '../../src/main/ole/core/calendarMatch'

const callTool = vi.fn(async (name: string, args: Record<string, unknown>) =>
  name === 'get_meeting_context' && /Globex/.test(`${args.focus ?? ''} ${args.meeting_title ?? ''}`) ? '{"matchedBy":"name","account":{"name":"Globex"}}' : '{"matchedBy":null}')
vi.mock('../../src/main/ole/core/mcp', async (orig) => {
  const real = await orig<typeof import('../../src/main/ole/core/mcp')>()
  return { ...real, createMcpClient: () => ({
    listTools: async () => [{ name: 'get_meeting_context', inputSchema: { type: 'object' }, annotations: { openWorldHint: false } }],
    listPrompts: async () => [], getPrompt: async () => '', callTool,
  }) }
})
type Req = { messages: Array<{ role: string; content: string | null }> }
const askOf = (req: Req) => req.messages.find(m => m.role === 'user' && (m.content ?? '').startsWith('Now:'))?.content ?? ''
let gate: Promise<void> | null = null
const openaiChat = vi.fn(async (req: Req) => {
  if (gate) { const g = gate; gate = null; await g }
  const sys = req.messages[0].content ?? ''
  if (sys.includes('surfacing short context bullets')) return { role: 'assistant', content: '{"bullets":[]}' }
  if (sys.includes('running record')) return { role: 'assistant', content: '{}' }
  return { role: 'assistant', content: /Globex/.test(askOf(req)) ? '## Before you join\n- Globex renewal (account: Globex)' : 'No matching record for this call.\n- General' }
})
vi.mock('../../src/main/ole/core/openai', async (orig) => ({ ...(await orig<object>()), openaiChat }))

const ID = '00000000-0000-4000-8000-000000000128'
const prepareCount = () => openaiChat.mock.calls.filter(c => askOf(c[0])).length

function fakeHost(events: () => Upcoming[], extra: Partial<OleSettings> = {}) {
  let t = 1_700_000_000_000
  const settings: OleSettings = { ...extra, oleAssistant: 'openai', oleMcpServers: [{ id: 'crm', name: 'CRM', url: 'https://crm.example/mcp', enabled: true }] }
  const secrets = new Map<SecretName, string>([['openai', 'sk-test-123456']])
  const host: OleHost = {
    settings: { get: () => settings, patch: (p) => Object.assign(settings, p) },
    secrets: { read: (n) => secrets.get(n) ?? null, write: () => {}, remove: () => {} },
    send: () => {}, files: {},
    calendar: { upcoming: async (from, to) => events().filter(e => e.end > from && e.start < to) },
    genericTitle: (x) => /^meeting$/i.test(x.trim()),
    clock: { now: () => t, after: () => {}, every: () => {} },
    log: { warn: () => {} },
  }
  return { host, now: () => t, advance: (ms: number) => { t += ms } }
}

async function session(events: () => Upcoming[] = () => [], extra: Partial<OleSettings> = {}) {
  const { createOleSession } = await import('../../src/main/ole/core/session')
  const h = fakeHost(events, extra)
  return { s: createOleSession(h.host, { checkEveryMs: 0, autoEveryMs: 0, summaryEveryMs: 0 }), ...h }
}

beforeEach(() => { callTool.mockClear(); openaiChat.mockClear() })

describe('Home shows the next meeting and its briefing (#126, #142)', () => {
  it('Prepares at (start minus the lead), Preparing…, then Briefing ready; the server\'s own match never says No match', async () => {
    let start = 0
    const { s, now } = await session(() => [{ id: 'e1', title: 'Globex renewal', start, end: start + 30 * 60_000 }])
    start = now() + 30 * 60_000
    expect(s.handlers.state().nextMeeting).toBeNull()
    await s.refreshNext()
    expect(s.handlers.state().nextMeeting).toEqual({ title: 'Globex renewal', start, status: 'scheduled', preparesAt: start - 10 * 60_000 })
    // nothing prepared yet: the server was never asked
    expect(callTool).not.toHaveBeenCalled()
    start = now() + 6 * 60_000
    await s.refreshNext()
    let release!: () => void
    gate = new Promise<void>(r => { release = r })
    const auto = s.autoPrepare()
    await vi.waitFor(() => expect(s.handlers.state().nextMeeting?.status).toBe('preparing'))
    release()
    await auto
    expect(s.handlers.state().nextMeeting).toMatchObject({ status: 'ready', preparesAt: null })
    // cleared: not prepared, and auto-prepare already did this one, so no state at all
    s.handlers.clearPrepared()
    expect(s.handlers.state().nextMeeting?.status).toBe('idle')
  })

  it('prepared for it with no matched record: No match; none during a call', async () => {
    let start = 0
    const { s, now } = await session(() => [{ id: 'e1', title: 'Team retro', start, end: start + 30 * 60_000 }])
    start = now() + 6 * 60_000
    await s.refreshNext()
    await s.autoPrepare()
    expect(s.handlers.state().prepared?.meetingTitle).toBe('Team retro')
    expect(s.handlers.state().nextMeeting?.status).toBe('no-match')
    s.meetingStarted({ id: ID, title: 'Team retro' })
    expect(s.handlers.state().nextMeeting).toBeNull()
    s.meetingStopped(ID)
  })

  it('auto-prepare off, a generic title, or a meeting already on: no state until prepared', async () => {
    let start = 0
    const off = await session(() => [{ id: 'e1', title: 'Globex renewal', start, end: start + 30 * 60_000 }], { oleAutoPrepare: false })
    start = off.now() + 30 * 60_000
    await off.s.refreshNext()
    expect(off.s.handlers.state().nextMeeting).toMatchObject({ status: 'idle', preparesAt: null })

    const generic = await session(() => [{ id: 'e2', title: 'Meeting', start, end: start + 30 * 60_000 }])
    await generic.s.refreshNext()
    expect(generic.s.handlers.state().nextMeeting?.status).toBe('idle')

    const on = await session(() => [{ id: 'e3', title: 'Globex renewal', start: on.now() - 60_000, end: on.now() + 30 * 60_000 }])
    await on.s.refreshNext()
    expect(on.s.handlers.state().nextMeeting?.status).toBe('idle')
  })

  it('the lead time comes from the settings', async () => {
    let start = 0
    const { s, now } = await session(() => [{ id: 'e1', title: 'Globex renewal', start, end: start + 30 * 60_000 }], { oleAutoPrepareLead: 5 })
    start = now() + 30 * 60_000
    await s.refreshNext()
    expect(s.handlers.state().nextMeeting?.preparesAt).toBe(start - 5 * 60_000)
  })
})

describe('Prepare now (#142)', () => {
  it('prepares with the meeting\'s title and start, counts as prepared, and auto-prepare does not repeat it', async () => {
    let start = 0
    const { s, now } = await session(() => [{ id: 'e1', title: 'Globex renewal', start, end: start + 30 * 60_000 }])
    start = now() + 6 * 60_000
    await s.refreshNext()
    await s.handlers.prepareNext()
    const args = callTool.mock.calls.find(c => c[0] === 'get_meeting_context')![1] as Record<string, unknown>
    expect(args.meeting_title).toBe('Globex renewal')
    expect(Date.parse(String(args.starts_at))).toBe(start)
    expect(s.handlers.state().prepared?.meetingTitle).toBe('Globex renewal')
    expect(s.handlers.state().nextMeeting?.status).toBe('ready')
    const n = prepareCount()
    await s.autoPrepare()
    expect(prepareCount()).toBe(n)
  })

  it('a call starting on that event reuses it (#128)', async () => {
    let start = 0
    const { s, now, advance } = await session(() => [{ id: 'e1', title: 'Globex renewal', start, end: start + 30 * 60_000 }])
    start = now() + 30 * 60_000
    await s.refreshNext()
    await s.handlers.prepareNext()
    const n = prepareCount()
    advance(30 * 60_000)
    s.meetingStarted({ id: ID, title: 'Meeting' })
    await new Promise(r => setTimeout(r, 30))
    expect(prepareCount()).toBe(n)
    expect(s.handlers.state().prepared?.meetingTitle).toBe('Globex renewal')
    s.meetingStopped(ID)
  })

  it('refused during a call, while preparing, and with no next meeting', async () => {
    let start = 0
    const { s, now } = await session(() => [{ id: 'e1', title: 'Globex renewal', start, end: start + 30 * 60_000 }])
    await s.handlers.prepareNext()
    expect(prepareCount()).toBe(0)
    start = now() + 30 * 60_000
    await s.refreshNext()
    let release!: () => void
    gate = new Promise<void>(r => { release = r })
    const first = s.handlers.prepare({ focus: 'Initech' })
    await vi.waitFor(() => expect(s.handlers.state().preparing).toBe(true))
    await s.handlers.prepareNext()
    release()
    await first
    expect(prepareCount()).toBe(1)
    s.meetingStarted({ id: ID, title: 'Weekly sync' })
    callTool.mockClear()
    await s.handlers.prepareNext()
    expect(callTool.mock.calls.some(c => (c[1] as Record<string, unknown>).meeting_title === 'Globex renewal')).toBe(false)
    s.meetingStopped(ID)
  })
})
