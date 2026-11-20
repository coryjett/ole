import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (n: string, f: (...a: unknown[]) => unknown) => handlers.set(n, f) },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
}))
vi.mock('../../src/main/ole/core/mcp', async (orig) => {
  const real = await orig<typeof import('../../src/main/ole/core/mcp')>()
  return { ...real, createMcpClient: () => ({ listTools: async () => [{ name: 'get_upcoming_meetings', inputSchema: { type: 'object' } }], listPrompts: async () => [], getPrompt: async () => '', callTool: async () => '[]' }) }
})
const openaiChat = vi.fn(async (req: { messages: Array<{ role: string; content: string }> }) => {
  const sys = req.messages[0].content
  if (sys.includes('surfacing short context bullets')) return { role: 'assistant', content: JSON.stringify({ bullets: [{ text: 'Renewal is in March', source: 'opportunity: Renewal' }] }) }
  if (sys.includes('question the user typed')) return { role: 'assistant', content: JSON.stringify({ answer: 'March.', source: 'opportunity: Renewal' }) }
  return { role: 'assistant', content: '## Before you join\n- x' }
})
vi.mock('../../src/main/ole/core/openai', () => ({ openaiChat }))

const ID = '00000000-0000-4000-8000-000000000001'
const userAsk = (i: number) => (openaiChat.mock.calls[i][0] as { messages: Array<{ role: string; content: string }> }).messages.find(m => m.role === 'user' && m.content.startsWith('Now:'))?.content ?? ''

async function setup(extra: Record<string, unknown> = {}) {
  const { hookOle } = await import('../../src/main/ole/yogurt/session')
  const { writeSecret } = await import('../../src/main/ole/yogurt/secrets')
  const { setProviders } = await import('../../src/main/ole/yogurt/providers')
  const { setServers } = await import('../../src/main/ole/yogurt/servers')
  const file = join(mkdtempSync(join(tmpdir(), 'ole-live-')), 'settings.json')
  writeSecret(file, 'openai', 'sk-test-123456')
  setProviders(file, { assistant: 'openai' })
  setServers(file, [{ id: 'crm', name: 'CRM', url: 'https://crm.example/mcp' }])
  const appendNotes = vi.fn()
  const notify = vi.fn()
  const ole = hookOle({ file, send: () => {}, checkEveryMs: 0, autoEveryMs: 0, appendNotes, notify, ...extra })
  return { ole, file, appendNotes, notify }
}
const state = () => handlers.get('ole:state')!() as { bullets: Array<{ id: string; pinned?: boolean; rating?: string }>; answers: Array<{ text: string; question: string; pending?: boolean }>; prepared: { meetingTitle: string | null } | null }

beforeEach(() => { openaiChat.mockClear() })

describe('pin, rate and ask during a call (#53, #54, #55)', () => {
  it('pinned bullets go into the notes when the call ends; a rating is remembered for later calls', async () => {
    const { ole, file, appendNotes } = await setup()
    ole.meetingStarted({ id: ID, title: 'Acme renewal' })
    ole.segment({ meetingId: ID, track: 'them', text: 'when is the renewal again', startMs: 0 })
    await vi.waitFor(() => expect(state().bullets).toHaveLength(1), { timeout: 3000 })
    const b = state().bullets[0]
    await handlers.get('ole:bullet:pin')!({}, b.id, true)
    await handlers.get('ole:bullet:rate')!({}, b.id, 'up')
    expect(state().bullets[0]).toMatchObject({ pinned: true, rating: 'up' })
    const { feedbackOf } = await import('../../src/main/ole/yogurt/feedback')
    expect(feedbackOf(file).useful).toEqual(['Renewal is in March'])
    // bad input is ignored
    await handlers.get('ole:bullet:rate')!({}, b.id, 'great')
    expect(state().bullets[0].rating).toBe('up')
    ole.meetingStopped(ID)
    expect(appendNotes).toHaveBeenCalledWith(ID, '## Pinned from the call\n- Renewal is in March (opportunity: Renewal)')
  })

  it('a question during the call is answered and kept with the call', async () => {
    const saveAnswers = vi.fn()
    const { ole } = await setup({ saveAnswers })
    ole.meetingStarted({ id: ID, title: 'Acme renewal' })
    await handlers.get('ole:ask')!({}, '  when is the renewal?  ')
    expect(state().answers[0]).toMatchObject({ question: 'when is the renewal?', text: 'March.' })
    expect(state().answers[0].pending).toBeUndefined()
    // empty or outside a call: nothing
    await handlers.get('ole:ask')!({}, '   ')
    expect(state().answers).toHaveLength(1)
    ole.meetingStopped(ID)
    expect(saveAnswers).toHaveBeenCalledWith(ID, [expect.objectContaining({ text: 'March.' })])
    await handlers.get('ole:ask')!({}, 'anything')
    expect(state().answers).toHaveLength(0)
  })
})

describe('a failed answer is marked as not real (security)', () => {
  it('the error branch sets ok: false, so the notes leave it out', async () => {
    const { ole, appendNotes } = await setup()
    const real = openaiChat.getMockImplementation()!
    openaiChat.mockImplementation(async (req) => {
      if (req.messages[0].content.includes('question the user typed')) throw new Error('down')
      return real(req)
    })
    try {
      ole.meetingStarted({ id: ID, title: 'Acme renewal' })
      await handlers.get('ole:ask')!({}, 'when is the renewal?')
      expect(state().answers[0]).toMatchObject({ text: "Couldn't answer: down", ok: false })
      ole.meetingStopped(ID)
      expect(appendNotes).not.toHaveBeenCalled()
    } finally { openaiChat.mockImplementation(real) }
  })
})

describe('the calendar decides what a default-titled call is (#56)', () => {
  it('a "Meeting" recording is prepared for the event on now', async () => {
    const now = Date.now()
    const upcoming = vi.fn(async () => [{ id: 'e1', title: 'Acme | Kickoff', start: now - 2 * 60_000, end: now + 30 * 60_000 }])
    const { ole } = await setup({ upcoming })
    ole.meetingStarted({ id: ID, title: 'Meeting' })
    await vi.waitFor(() => expect(openaiChat).toHaveBeenCalled())
    expect(userAsk(0)).toContain('Meeting: Acme | Kickoff')
    ole.meetingStopped(ID)
  })

  it('with nothing on now, the prompt asks for the meeting happening now only', async () => {
    const { ole } = await setup({ upcoming: async () => [] })
    ole.meetingStarted({ id: ID, title: 'Meeting' })
    await vi.waitFor(() => expect(openaiChat).toHaveBeenCalled())
    expect(userAsk(0)).toContain('Meeting: not given')
    expect(userAsk(0)).toContain('happening now')
    expect(userAsk(0)).not.toContain('next upcoming')
    ole.meetingStopped(ID)
  })
})

describe('auto-prepare before calendar meetings (#52)', () => {
  it('prepares once for a meeting inside the lead time and says when it is ready', async () => {
    const now = Date.now()
    const upcoming = vi.fn(async () => [{ id: 'e2', title: 'Beta kickoff', start: now + 6 * 60_000, end: now + 36 * 60_000 }])
    const { ole, notify } = await setup({ upcoming })
    await ole.autoPrepare()
    expect(state().prepared?.meetingTitle).toBe('Beta kickoff')
    expect(notify).toHaveBeenCalledWith('Your briefing is ready', 'Beta kickoff')
    await ole.autoPrepare()
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('does nothing when turned off', async () => {
    const now = Date.now()
    const upcoming = vi.fn(async () => [{ id: 'e3', title: 'Gamma', start: now + 6 * 60_000, end: now + 36 * 60_000 }])
    const { ole, file, notify } = await setup({ upcoming })
    const { setProviders } = await import('../../src/main/ole/yogurt/providers')
    setProviders(file, { autoPrepare: false })
    await ole.autoPrepare()
    expect(upcoming).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })
})
