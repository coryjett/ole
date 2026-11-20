// The session gets its meetings from the meeting source (#98): a server's list for auto-prepare and the meeting on now,
// its note to Prepare and the live bullets, the host calendar only when no server supplies meetings.
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { OleHost, OleSettings } from '../../src/main/ole/core/host'
import type { SecretName } from '../../src/main/ole/core/types'

const callTool = vi.fn(async (name: string, _args: Record<string, unknown>) => name === 'get_upcoming_meetings' ? upcomingResult() : '{"matchedBy":null}')
let upcomingResult = () => '[]'
vi.mock('../../src/main/ole/core/mcp', async (orig) => {
  const real = await orig<typeof import('../../src/main/ole/core/mcp')>()
  return { ...real, createMcpClient: () => ({ listTools: async () => [{ name: 'get_upcoming_meetings', inputSchema: { type: 'object' } }, { name: 'get_meeting_context', inputSchema: { type: 'object' } }], listPrompts: async () => [], getPrompt: async () => '', callTool }) }
})
const openaiChat = vi.fn(async (req: { messages: Array<{ role: string; content: string }> }) => {
  if (req.messages[0].content.includes('surfacing short context bullets')) return { role: 'assistant', content: JSON.stringify({ bullets: [] }) }
  return { role: 'assistant', content: '## Before you join\n- x' }
})
vi.mock('../../src/main/ole/core/openai', async (orig) => ({ ...(await orig<object>()), openaiChat }))

const ID = '00000000-0000-4000-8000-000000000009'
const userAsk = (i: number) => openaiChat.mock.calls[i][0].messages.find(m => m.role === 'user' && m.content.startsWith('Now:'))?.content ?? ''

function host(calendar?: OleHost['calendar'], settings: OleSettings = { oleAssistant: 'openai', oleMcpServers: [{ id: 'crm', name: 'CRM', url: 'https://crm.example/mcp', enabled: true }] }): OleHost {
  const secrets = new Map<SecretName, string>([['openai', 'sk-test-123456']])
  return {
    settings: { get: () => settings, patch: (p) => (settings = { ...settings, ...p }) },
    secrets: { read: (n) => secrets.get(n) ?? null, write: () => {}, remove: () => {} },
    send: () => {}, notify: () => {}, calendar, files: {},
    genericTitle: (t) => /^meeting$/i.test(t.trim()),
    clock: { now: () => Date.now(), after: () => {}, every: () => {} },
    log: { warn: () => {} },
  }
}
const iso = (ms: number) => new Date(ms).toISOString()

beforeEach(() => { callTool.mockClear(); openaiChat.mockClear(); upcomingResult = () => '[]' })

describe('meetings from the MCP servers in the session (#98)', () => {
  it('auto-prepare uses the server list, passes the start to the context tool and the note to Prepare', async () => {
    const start = Date.now() + 6 * 60_000
    upcomingResult = () => JSON.stringify([{ id: 'm1', title: 'Beta kickoff', startTime: iso(start), endTime: iso(start + 1800_000), aiSummary: 'Renewal due in March' }])
    const calendar = { upcoming: vi.fn(async () => [{ id: 'h', title: 'Host only', start, end: start + 1800_000 }]) }
    const { createOleSession } = await import('../../src/main/ole/core/session')
    const s = createOleSession(host(calendar), { checkEveryMs: 0, autoEveryMs: 0 })
    await s.autoPrepare()
    expect(s.handlers.state().prepared?.meetingTitle).toBe('Beta kickoff')
    expect(calendar.upcoming).not.toHaveBeenCalled()
    expect(callTool).toHaveBeenCalledWith('get_meeting_context', { meeting_title: 'Beta kickoff', starts_at: iso(start) }, expect.anything())
    expect(userAsk(0)).toContain('Note about this meeting from CRM: Renewal due in March')
  })

  it('auto-prepare works with no host calendar at all', async () => {
    const start = Date.now() + 6 * 60_000
    upcomingResult = () => JSON.stringify({ meetings: [{ title: 'Gamma review', start: iso(start) }] })
    const { createOleSession } = await import('../../src/main/ole/core/session')
    const s = createOleSession(host(undefined), { checkEveryMs: 0, autoEveryMs: 0 })
    await s.autoPrepare()
    expect(s.handlers.state().prepared?.meetingTitle).toBe('Gamma review')
  })

  it('a default-titled call is named by the server meeting on now, and its note reaches the live bullets', async () => {
    const start = Date.now() - 2 * 60_000
    upcomingResult = () => JSON.stringify([{ title: 'Delta planning', start: iso(start), end: iso(start + 1800_000), note: 'Pricing open' }])
    const { createOleSession } = await import('../../src/main/ole/core/session')
    const s = createOleSession(host({ upcoming: async () => [] }), { checkEveryMs: 0, autoEveryMs: 0, summaryEveryMs: 0 })
    s.meetingStarted({ id: ID, title: 'Meeting' })
    await vi.waitFor(() => expect(s.handlers.state().prepared?.meetingTitle).toBe('Delta planning'), { timeout: 3000 })
    expect(callTool).toHaveBeenCalledWith('get_meeting_context', { meeting_title: 'Delta planning', starts_at: iso(start) }, expect.anything())
    s.segment({ meetingId: ID, track: 'them', text: 'what about pricing', startMs: 0 })
    await vi.waitFor(() => expect(openaiChat.mock.calls.some(c => c[0].messages[0].content.includes('surfacing short context bullets'))).toBe(true), { timeout: 3000 })
    const turn = openaiChat.mock.calls.find(c => c[0].messages[0].content.includes('surfacing short context bullets'))![0]
    expect(turn.messages[1].content).toContain('Note about this meeting from CRM: Pricing open')
    s.meetingStopped(ID)
  })

  it('with the Assistant on Local the servers are never asked for meetings; the host calendar is used', async () => {
    const start = Date.now() + 6 * 60_000
    const calendar = { upcoming: vi.fn(async () => [{ id: 'h', title: 'Host meeting', start, end: start + 1800_000 }]) }
    const { createOleSession } = await import('../../src/main/ole/core/session')
    const s = createOleSession(host(calendar, { oleAssistant: 'local', oleMcpServers: [{ id: 'crm', name: 'CRM', url: 'https://crm.example/mcp', enabled: true }] }), { checkEveryMs: 0, autoEveryMs: 0 })
    s.meetingStarted({ id: ID, title: 'Meeting' })
    await new Promise(r => setTimeout(r, 30))
    expect(callTool).not.toHaveBeenCalled()
    expect(calendar.upcoming).toHaveBeenCalled()
    s.meetingStopped(ID)
  })
})
