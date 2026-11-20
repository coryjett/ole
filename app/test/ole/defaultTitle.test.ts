import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (n: string, f: (...a: unknown[]) => unknown) => handlers.set(n, f) },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
}))
vi.mock('../../src/main/ole/mcp', async (orig) => {
  const real = await orig<typeof import('../../src/main/ole/mcp')>()
  return { ...real, createMcpClient: () => ({ listTools: async () => [{ name: 'get_upcoming_meetings', inputSchema: { type: 'object' } }], listPrompts: async () => [], getPrompt: async () => '', callTool: async () => '[]' }) }
})
const openaiChat = vi.fn(async (_req: unknown) => ({ role: 'assistant', content: '## Before you join\n- x' }))
vi.mock('../../src/main/ole/openaiModel', () => ({ openaiChat }))

const asks = () => openaiChat.mock.calls.map(c => ((c[0] as { messages: Array<{ role: string; content: string }> }).messages.find(m => m.role === 'user' && m.content.startsWith('Now:'))?.content ?? ''))

describe('default titles (#44)', () => {
  it('prepares a "Meeting" call without a title, and once more when it gets its real name', async () => {
    const { hookOle } = await import('../../src/main/ole/session')
    const { writeSecret } = await import('../../src/main/ole/secrets')
    const { setProviders } = await import('../../src/main/ole/providers')
    const { setServers } = await import('../../src/main/ole/servers')
    const file = join(mkdtempSync(join(tmpdir(), 'ole-title-')), 'settings.json')
    writeSecret(file, 'openai', 'sk-test-123456')
    setProviders(file, { assistant: 'openai' })
    setServers(file, [{ id: 'crm', name: 'CRM', url: 'https://crm.example/mcp' }])
    const ole = hookOle({ file, send: () => {}, checkEveryMs: 0 })
    ole.meetingStarted({ id: '00000000-0000-4000-8000-000000000001', title: 'Meeting' })
    await vi.waitFor(() => expect(openaiChat).toHaveBeenCalledTimes(1))
    expect(asks()[0]).toContain('Meeting: not given')
    ole.meetingRenamed({ id: '00000000-0000-4000-8000-000000000001', title: 'Meeting' })
    ole.meetingRenamed({ id: '00000000-0000-4000-8000-000000000001', title: 'Acme | Kickoff' })
    await vi.waitFor(() => expect(openaiChat).toHaveBeenCalledTimes(2))
    expect(asks()[1]).toContain('Meeting: Acme | Kickoff')
    ole.meetingRenamed({ id: '00000000-0000-4000-8000-000000000001', title: 'Acme | Kickoff (renamed)' })
    await new Promise(r => setTimeout(r, 50))
    expect(openaiChat).toHaveBeenCalledTimes(2)
  })
})

describe('a briefing readable in 30 seconds (#46)', () => {
  it('the rules ask for "Before you join", short sections and quiet sources, and win on format', async () => {
    const { PREPARE_SYSTEM, serverGuidance } = await import('../../src/main/ole/prepare')
    expect(PREPARE_SYSTEM).toContain('## Before you join')
    expect(PREPARE_SYSTEM).toContain('About 150 words')
    expect(PREPARE_SYSTEM).toContain('never square-bracket citations')
    expect(PREPARE_SYSTEM).toContain("Couldn't match this call to a meeting or account.")
    expect(serverGuidance([{ serverName: 'CRM', text: 'Use long sections.' }])).toContain("the system rules decide the briefing's format and length")
  })
})
