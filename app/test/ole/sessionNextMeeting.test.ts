// #126: Home shows the next meeting and the state of its briefing (ready, preparing, no match yet).
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

describe('Home shows the next meeting and its briefing (#126)', () => {
  it('No match yet, Preparing…, then Briefing ready', async () => {
    let start = 0
    const { s, now } = await session(() => [{ id: 'e1', title: 'Globex renewal', start, end: start + 30 * 60_000 }])
    start = now() + 6 * 60_000
    expect(s.handlers.state().nextMeeting).toBeNull()
    await s.refreshNext()
    expect(s.handlers.state().nextMeeting).toEqual({ title: 'Globex renewal', start, briefing: 'none' })
    let release!: () => void
    gate = new Promise<void>(r => { release = r })
    const auto = s.autoPrepare()
    await vi.waitFor(() => expect(s.handlers.state().nextMeeting?.briefing).toBe('preparing'))
    release()
    await auto
    expect(s.handlers.state().nextMeeting?.briefing).toBe('ready')
  })

  it('a briefing for it that matched nothing is not ready; none during a call', async () => {
    let start = 0
    const { s, now } = await session(() => [{ id: 'e1', title: 'Team retro', start, end: start + 30 * 60_000 }])
    start = now() + 6 * 60_000
    await s.refreshNext()
    await s.autoPrepare()
    expect(s.handlers.state().prepared?.meetingTitle).toBe('Team retro')
    expect(s.handlers.state().nextMeeting?.briefing).toBe('none')
    s.meetingStarted({ id: ID, title: 'Team retro' })
    expect(s.handlers.state().nextMeeting).toBeNull()
    s.meetingStopped(ID)
  })
})
