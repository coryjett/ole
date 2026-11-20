// #82 and #83 in the session: open questions and commitments in the live state, saved with the meeting, and the
// "From Ole" notes section when the call ends.
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
const record = { summary: 'They want rate limits for the morning burst.', openQuestions: ['Is there a free tier?'], commitments: [{ who: 'Me', what: 'Send the benchmark plan' }] }
const usual = async (req: { messages: Array<{ role: string; content: string }> }) => {
  const sys = req.messages[0].content
  if (sys.includes('surfacing short context bullets')) return { role: 'assistant', content: '{"bullets":[]}' }
  if (sys.includes('running record of a live call')) return { role: 'assistant', content: JSON.stringify(record) }
  if (sys.includes('question the user typed')) return { role: 'assistant', content: JSON.stringify({ answer: 'Burst limits shipped in 2.3.', source: 'release notes' }) }
  return { role: 'assistant', content: '## Before you join\n- x' }
}
const openaiChat = vi.fn(usual)
vi.mock('../../src/main/ole/core/openai', () => ({ openaiChat }))

const ID = '00000000-0000-4000-8000-000000000002'

async function setup(extra: Record<string, unknown> = {}) {
  const { hookOle } = await import('../../src/main/ole/yogurt/session')
  const { writeSecret } = await import('../../src/main/ole/yogurt/secrets')
  const { setProviders } = await import('../../src/main/ole/yogurt/providers')
  const { setServers } = await import('../../src/main/ole/yogurt/servers')
  const file = join(mkdtempSync(join(tmpdir(), 'ole-record-')), 'settings.json')
  writeSecret(file, 'openai', 'sk-test-123456')
  setProviders(file, { assistant: 'openai' })
  setServers(file, [{ id: 'crm', name: 'CRM', url: 'https://crm.example/mcp' }])
  const appendNotes = vi.fn()
  const saveCall = vi.fn()
  const sent: Array<{ openQuestions: string[]; commitments: unknown[] }> = []
  const ole = hookOle({ file, send: s => sent.push(s), checkEveryMs: 0, autoEveryMs: 0, summaryEveryMs: 0, appendNotes, saveCall, ...extra })
  return { ole, appendNotes, saveCall, sent }
}
const state = () => handlers.get('ole:state')!() as { openQuestions: string[]; commitments: Array<{ who: string; what: string }> }

beforeEach(() => { openaiChat.mockReset(); openaiChat.mockImplementation(usual) })

describe('open questions and commitments during and after the call (#82)', () => {
  it('reach the live state as the summary updates, and are saved with the meeting', async () => {
    const { ole, saveCall, sent } = await setup()
    ole.meetingStarted({ id: ID, title: 'Rate limits' })
    expect(state()).toMatchObject({ openQuestions: [], commitments: [] })
    ole.segment({ meetingId: ID, track: 'them', text: 'do you have a free tier', startMs: 0 })
    await vi.waitFor(() => expect(state().openQuestions).toEqual(['Is there a free tier?']), { timeout: 3000 })
    expect(state().commitments).toEqual([{ who: 'Me', what: 'Send the benchmark plan' }])
    // the panel was told when they changed
    expect(sent.some(s => s.openQuestions.length === 1)).toBe(true)
    ole.meetingStopped(ID)
    expect(saveCall).toHaveBeenCalledWith(ID, record)
    expect(await handlers.get('ole:call')!({}, ID)).toEqual(record)
    expect(await handlers.get('ole:call')!({}, 'not-an-id')).toBeNull()
    // the next call starts clean
    expect(state()).toMatchObject({ openQuestions: [], commitments: [] })
  })

  it('a meeting from before a restart is read back from disk', async () => {
    const loadCall = vi.fn(() => record)
    await setup({ loadCall })
    const other = '00000000-0000-4000-8000-0000000000ff'
    expect(await handlers.get('ole:call')!({}, other)).toEqual(record)
    expect(loadCall).toHaveBeenCalledWith(other)
  })

  it('Ask gets the open questions and commitments with the summary', async () => {
    const { ole } = await setup()
    ole.meetingStarted({ id: ID, title: 'Rate limits' })
    ole.segment({ meetingId: ID, track: 'them', text: 'do you have a free tier', startMs: 0 })
    await vi.waitFor(() => expect(state().openQuestions).toHaveLength(1), { timeout: 3000 })
    await handlers.get('ole:ask')!({}, 'what shipped in 2.3?')
    const ask = openaiChat.mock.calls.map(c => c[0].messages).find(m => m[0].content.includes('question the user typed'))!
    expect(ask[1].content).toContain('Open questions:\n- Is there a free tier?')
    expect(ask[1].content).toContain('Commitments:\n- Me: Send the benchmark plan')
    ole.meetingStopped(ID)
  })
})

describe('the "From Ole" section when the call ends (#83): an input to the summary, not My notes (#168)', () => {
  it('is given to the summary writer, and My notes stays untouched', async () => {
    const { ole, appendNotes } = await setup()
    ole.meetingStarted({ id: ID, title: 'Rate limits' })
    ole.segment({ meetingId: ID, track: 'them', text: 'do you have a free tier', startMs: 0 })
    await vi.waitFor(() => expect(state().openQuestions).toHaveLength(1), { timeout: 3000 })
    await handlers.get('ole:ask')!({}, 'what shipped in 2.3?')
    ole.meetingStopped(ID)
    expect(appendNotes).not.toHaveBeenCalled()
    expect(ole.notesInput(ID)).toBe([
      '## From Ole',
      'They want rate limits for the morning burst.',
      '',
      '**Open questions**',
      '- Is there a free tier?',
      '',
      '**Commitments**',
      '- Me: Send the benchmark plan',
      '',
      '**Asked during the call**',
      '- what shipped in 2.3?: Burst limits shipped in 2.3. (release notes)',
    ].join('\n'))
  })

  it('pinned bullets come first', async () => {
    openaiChat.mockImplementation(async (req: { messages: Array<{ role: string; content: string }> }) => {
      const sys = req.messages[0].content
      if (sys.includes('surfacing short context bullets')) return { role: 'assistant', content: JSON.stringify({ bullets: [{ text: 'Renewal is in March', source: 'opportunity: Renewal' }] }) }
      if (sys.includes('running record of a live call')) return { role: 'assistant', content: JSON.stringify(record) }
      return { role: 'assistant', content: '## Before you join\n- x' }
    })
    const { ole, appendNotes } = await setup()
    ole.meetingStarted({ id: ID, title: 'Rate limits' })
    ole.segment({ meetingId: ID, track: 'them', text: 'when is the renewal', startMs: 0 })
    const bullets = () => (handlers.get('ole:state')!() as { bullets: Array<{ id: string }> }).bullets
    await vi.waitFor(() => expect(bullets()).toHaveLength(1), { timeout: 3000 })
    await vi.waitFor(() => expect(state().openQuestions).toHaveLength(1), { timeout: 3000 })
    await handlers.get('ole:bullet:pin')!({}, bullets()[0].id, true)
    ole.meetingStopped(ID)
    expect(appendNotes).not.toHaveBeenCalled()
    const md = ole.notesInput(ID)
    expect(md.startsWith('## Pinned from the call\n- Renewal is in March (opportunity: Renewal)\n\n## From Ole\n')).toBe(true)
  })

  it('a call where Ole kept nothing adds nothing to the notes', async () => {
    openaiChat.mockImplementation(async () => ({ role: 'assistant', content: '{"bullets":[]}' }))
    const { ole, appendNotes } = await setup({ summaryEveryMs: 60 * 60_000 })
    ole.meetingStarted({ id: ID, title: 'Rate limits' })
    ole.segment({ meetingId: ID, track: 'them', text: 'hello', startMs: 0 })
    ole.meetingStopped(ID)
    expect(appendNotes).not.toHaveBeenCalled()
    expect(ole.notesInput(ID)).toBe('')
  })
})
