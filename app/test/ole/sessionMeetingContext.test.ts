import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// the session passes the calendar event's start to a server's meeting-context tool (#93)
vi.mock('electron', () => ({
  ipcMain: { handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
}))
const callTool = vi.fn(async (_name: string, _args: Record<string, unknown>) => '{"matchedBy":null}')
vi.mock('../../src/main/ole/mcp', async (orig) => {
  const real = await orig<typeof import('../../src/main/ole/mcp')>()
  const properties = { meeting_title: { type: 'string' }, focus: { type: 'string' }, starts_at: { type: 'string' } }
  return { ...real, createMcpClient: () => ({ listTools: async () => [{ name: 'get_meeting_context', inputSchema: { type: 'object', properties } }], listPrompts: async () => [], getPrompt: async () => '', callTool }) }
})
const openaiChat = vi.fn(async () => ({ role: 'assistant', content: '## Before you join\n- x' }))
vi.mock('../../src/main/ole/openaiModel', () => ({ openaiChat }))

const ID = '00000000-0000-4000-8000-000000000002'

async function setup(extra: Record<string, unknown> = {}) {
  const { hookOle } = await import('../../src/main/ole/session')
  const { writeSecret } = await import('../../src/main/ole/secrets')
  const { setProviders } = await import('../../src/main/ole/providers')
  const { setServers } = await import('../../src/main/ole/servers')
  const file = join(mkdtempSync(join(tmpdir(), 'ole-ctx-')), 'settings.json')
  writeSecret(file, 'openai', 'sk-test-123456')
  setProviders(file, { assistant: 'openai' })
  setServers(file, [{ id: 'crm', name: 'CRM', url: 'https://crm.example/mcp' }])
  return hookOle({ file, send: () => {}, checkEveryMs: 0, autoEveryMs: 0, appendNotes: vi.fn(), notify: vi.fn(), ...extra })
}

beforeEach(() => { callTool.mockClear(); openaiChat.mockClear() })

describe('Prepare passes the meeting start to a meeting-context tool (#93)', () => {
  it('auto-prepare sends the calendar event\'s start', async () => {
    const start = Date.now() + 6 * 60_000
    const ole = await setup({ upcoming: async () => [{ id: 'e1', title: 'Beta kickoff', start, end: start + 30 * 60_000 }] })
    await ole.autoPrepare()
    expect(callTool).toHaveBeenCalledWith('get_meeting_context', { meeting_title: 'Beta kickoff', starts_at: new Date(start).toISOString() }, expect.anything())
  })

  it('a default-titled call sends the start of the event on now', async () => {
    const start = Date.now() - 2 * 60_000
    const ole = await setup({ upcoming: async () => [{ id: 'e2', title: 'Gamma review', start, end: start + 30 * 60_000 }] })
    ole.meetingStarted({ id: ID, title: 'Meeting' })
    await vi.waitFor(() => expect(callTool).toHaveBeenCalled())
    expect(callTool).toHaveBeenCalledWith('get_meeting_context', { meeting_title: 'Gamma review', starts_at: new Date(start).toISOString() }, expect.anything())
    ole.meetingStopped(ID)
  })

  it('a named call with no calendar lookup sends the title only', async () => {
    const ole = await setup()
    ole.meetingStarted({ id: ID, title: 'Delta planning' })
    await vi.waitFor(() => expect(callTool).toHaveBeenCalled())
    expect(callTool).toHaveBeenCalledWith('get_meeting_context', { meeting_title: 'Delta planning' }, expect.anything())
    ole.meetingStopped(ID)
  })
})
