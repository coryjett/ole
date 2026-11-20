// #128: a prepared briefing can be cleared, and a call reuses a briefing from before it only when it belongs to it:
// auto-prepared for the same calendar event, or prepared by hand in the last 15 minutes. Otherwise the call starts
// without it. Also #126: Home's next meeting and its briefing's state.
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

function fakeHost(events: () => Upcoming[]) {
  let t = 1_700_000_000_000
  const settings: OleSettings = { oleAssistant: 'openai', oleMcpServers: [{ id: 'crm', name: 'CRM', url: 'https://crm.example/mcp', enabled: true }] }
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

async function session(events: () => Upcoming[] = () => []) {
  const { createOleSession } = await import('../../src/main/ole/core/session')
  const h = fakeHost(events)
  return { s: createOleSession(h.host, { checkEveryMs: 0, autoEveryMs: 0, summaryEveryMs: 0 }), ...h }
}

beforeEach(() => { callTool.mockClear(); openaiChat.mockClear() })

describe('a prepared briefing belongs to its meeting (#128)', () => {
  it('Clear discards it, and the next call starts without it', async () => {
    const { s } = await session()
    await s.handlers.prepare({ focus: 'Globex' })
    expect(s.handlers.state().prepared?.focus).toBe('Globex')
    const cleared = s.handlers.clearPrepared()
    expect(cleared.prepared).toBeNull()
    s.meetingStarted({ id: ID, title: 'Meeting' })
    await vi.waitFor(() => expect(s.handlers.state().prepared?.text).toContain('No matching record'), { timeout: 3000 })
    expect(s.handlers.state().prepared?.focus).toBeNull()
    expect(s.handlers.state().matched).toBe(false)
    s.meetingStopped(ID)
  })

  it('Clear does nothing during a call', async () => {
    const { s } = await session()
    s.meetingStarted({ id: ID, title: 'Globex renewal' })
    await vi.waitFor(() => expect(s.handlers.state().matched).toBe(true), { timeout: 3000 })
    expect(s.handlers.clearPrepared().prepared).not.toBeNull()
    s.meetingStopped(ID)
  })

  it('a briefing prepared by hand is reused within 15 minutes', async () => {
    const { s, advance } = await session()
    await s.handlers.prepare({ focus: 'Globex' })
    const n = prepareCount()
    advance(10 * 60_000)
    s.meetingStarted({ id: ID, title: 'Weekly sync' })
    await new Promise(r => setTimeout(r, 30))
    expect(prepareCount()).toBe(n)
    expect(s.handlers.state().prepared?.focus).toBe('Globex')
    s.meetingStopped(ID)
  })

  it('one prepared by hand more than 15 minutes ago is not', async () => {
    const { s, advance } = await session()
    await s.handlers.prepare({ focus: 'Globex' })
    advance(16 * 60_000)
    s.meetingStarted({ id: ID, title: 'Weekly sync' })
    expect(s.handlers.state().prepared).toBeNull()
    await vi.waitFor(() => expect(s.handlers.state().prepared?.text).toContain('No matching record'), { timeout: 3000 })
    expect(s.handlers.state().prepared?.meetingTitle).toBe('Weekly sync')
    s.meetingStopped(ID)
  })

  it('one auto-prepared for the same calendar event is reused', async () => {
    let start = 0
    const { s, now, advance } = await session(() => [{ id: 'e1', title: 'Globex renewal', start, end: start + 30 * 60_000 }])
    start = now() + 6 * 60_000
    await s.autoPrepare()
    expect(s.handlers.state().prepared?.meetingTitle).toBe('Globex renewal')
    const n = prepareCount()
    // hours later would be stale by the old rule; the event is what counts
    advance(6 * 60_000)
    s.meetingStarted({ id: ID, title: 'Meeting' })
    await new Promise(r => setTimeout(r, 30))
    expect(prepareCount()).toBe(n)
    expect(s.handlers.state().prepared?.meetingTitle).toBe('Globex renewal')
    s.meetingStopped(ID)
  })

  it('one auto-prepared for another event is not', async () => {
    let list: Upcoming[] = []
    const { s, now, advance } = await session(() => list)
    const first = now() + 6 * 60_000
    list = [{ id: 'e1', title: 'Globex renewal', start: first, end: first + 30 * 60_000 }]
    await s.autoPrepare()
    expect(s.handlers.state().prepared?.meetingTitle).toBe('Globex renewal')
    // the Globex meeting moved; another one is on now
    advance(3 * 60_000)
    list = [{ id: 'e2', title: 'Team retro', start: now() - 60_000, end: now() + 30 * 60_000 }]
    s.meetingStarted({ id: ID, title: 'Meeting' })
    await vi.waitFor(() => expect(s.handlers.state().prepared?.meetingTitle).toBe('Team retro'), { timeout: 3000 })
    expect(s.handlers.state().prepared?.text).not.toContain('Globex')
    s.meetingStopped(ID)
  })
})
