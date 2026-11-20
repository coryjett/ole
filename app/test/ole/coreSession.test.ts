// The core session runs against any OleHost (#97): an in-memory host, no Electron and no Yogurt module.
import { describe, expect, it, vi } from 'vitest'
import type { OleHost, OleSettings } from '../../src/main/ole/core/host'
import type { OleLiveState, SecretName } from '../../src/main/ole/core/types'

vi.mock('../../src/main/ole/core/mcp', async (orig) => {
  const real = await orig<typeof import('../../src/main/ole/core/mcp')>()
  return { ...real, createMcpClient: () => ({ listTools: async () => [{ name: 'search_accounts', inputSchema: { type: 'object' } }], listPrompts: async () => [], getPrompt: async () => '', callTool: async () => '[]' }) }
})
const openaiChat = vi.fn(async (req: { messages: Array<{ role: string; content: string }> }) => {
  const sys = req.messages[0].content
  if (sys.includes('surfacing short context bullets')) return { role: 'assistant', content: JSON.stringify({ bullets: [{ text: 'Renewal is in March', source: 'opportunity: Renewal' }] }) }
  if (sys.includes('question the user typed')) return { role: 'assistant', content: JSON.stringify({ answer: 'March.', source: 'opportunity: Renewal' }) }
  return { role: 'assistant', content: '## Before you join\n- x' }
})
vi.mock('../../src/main/ole/core/openai', async (orig) => ({ ...(await orig<object>()), openaiChat }))

const ID = '00000000-0000-4000-8000-000000000007'

function memoryHost() {
  let settings: OleSettings = { oleAssistant: 'openai', oleMcpServers: [{ id: 'crm', name: 'CRM', url: 'https://crm.example/mcp', enabled: true }] }
  const secrets = new Map<SecretName, string>([['openai', 'sk-test-123456']])
  const saved = new Map<string, unknown>()
  const timers: Array<{ ms: number; every: boolean }> = []
  const sent: OleLiveState[] = []
  const appended: string[] = []
  const host: OleHost = {
    settings: { get: () => settings, patch: (p) => (settings = { ...settings, ...p }) },
    secrets: { read: (n) => secrets.get(n) ?? null, write: (n, v) => { if (v) secrets.set(n, v); else secrets.delete(n) }, remove: (n) => { secrets.delete(n) } },
    send: (s) => { sent.push(s) },
    notes: { read: () => 'my notes', append: (_id, md) => { appended.push(md) } },
    files: {
      saveBullets: (id, b) => saved.set(`bullets:${id}`, b), loadBullets: (id) => (saved.get(`bullets:${id}`) as never) ?? [],
      saveBriefing: (id, t) => saved.set(`briefing:${id}`, t), loadBriefing: (id) => (saved.get(`briefing:${id}`) as string) ?? '',
    },
    genericTitle: (t) => /^(meeting|zoom call)$/i.test(t.trim()),
    clock: { now: () => Date.now(), after: (ms) => { timers.push({ ms, every: false }) }, every: (ms) => { timers.push({ ms, every: true }) } },
    log: { warn: () => {} },
  }
  return { host, saved, timers, sent, appended, settings: () => settings }
}

describe('createOleSession on an in-memory host', () => {
  it('runs a call and keeps what it made through the host', async () => {
    const { createOleSession } = await import('../../src/main/ole/core/session')
    const m = memoryHost()
    const s = createOleSession(m.host, { summaryEveryMs: 0 })
    // background checks go through the host's timers: one soon after start, then every 10 min; the next meeting for
    // Home soon after start (#126), then with auto-prepare every 2 min
    expect(m.timers).toEqual([{ ms: 5_000, every: false }, { ms: 600_000, every: true }, { ms: 5_000, every: false }, { ms: 120_000, every: true }])
    s.meetingStarted({ id: ID, title: 'Acme renewal' })
    s.segment({ meetingId: ID, track: 'them', text: 'when is the renewal again', startMs: 0 })
    await vi.waitFor(() => expect(s.handlers.state().bullets).toHaveLength(1), { timeout: 3000 })
    const b = s.handlers.state().bullets[0]
    s.handlers.pin(b.id, true)
    s.handlers.rate(b.id, 'up')
    expect(m.settings().oleFeedback?.useful).toEqual(['Renewal is in March'])
    await vi.waitFor(() => expect(s.handlers.state().prepared?.text).toContain('Before you join'), { timeout: 3000 })
    s.meetingStopped(ID)
    expect(m.appended).toEqual([])
    expect(s.notesInput(ID)).toContain('Renewal is in March')
    expect(s.handlers.bullets(ID)).toHaveLength(1)
    expect(m.saved.get(`bullets:${ID}`)).toHaveLength(1)
    expect(s.handlers.briefing(ID)).toContain('Before you join')
    expect(m.sent.at(-1)?.meetingId).toBeNull()
    // bad input from the UI is refused by the core, not the host
    expect(s.handlers.bullets('not-an-id')).toEqual([])
    expect(await s.handlers.exportReplay(ID, {})).toEqual({ status: 'failed', error: "Couldn't export this meeting." })
  })
})
