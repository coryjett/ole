import { describe, expect, it, vi } from 'vitest'
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
  return { ...real, createMcpClient: () => ({ listTools: async () => { throw new real.McpError('The MCP server rejected the key', 'auth') }, listPrompts: async () => [], getPrompt: async () => '', callTool: async () => '' }) }
})
const openaiChat = vi.fn()
vi.mock('../../src/main/ole/core/openai', () => ({ openaiChat }))

describe('Prepare with every MCP server down (#33)', () => {
  it('says which servers failed and why, and writes no briefing', async () => {
    const { hookOle } = await import('../../src/main/ole/yogurt/session')
    const { writeSecret } = await import('../../src/main/ole/yogurt/secrets')
    const { setProviders } = await import('../../src/main/ole/yogurt/providers')
    const { setServers } = await import('../../src/main/ole/yogurt/servers')
    const file = join(mkdtempSync(join(tmpdir(), 'ole-down-')), 'settings.json')
    writeSecret(file, 'openai', 'sk-test-123456')
    setProviders(file, { assistant: 'openai' })
    setServers(file, [{ id: 'crm', name: 'CRM', url: 'https://crm.example/mcp' }])
    hookOle({ file, send: () => {}, checkEveryMs: 0 })
    const s = await handlers.get('ole:prepare')!({}, {}) as { error: string | null; prepared: unknown; unavailable: Array<{ name: string; reason: string }> }
    expect(s.error).toBe("Couldn't use any MCP server: CRM (key rejected).")
    expect(s.prepared).toBeNull()
    expect(s.unavailable).toEqual([{ name: 'CRM', reason: 'key rejected' }])
    expect(openaiChat).not.toHaveBeenCalled()
  })
})

describe('background server checks (#33)', () => {
  it('notifies once when a server starts failing, not on every check', async () => {
    const { hookOle } = await import('../../src/main/ole/yogurt/session')
    const { writeSecret } = await import('../../src/main/ole/yogurt/secrets')
    const { setProviders } = await import('../../src/main/ole/yogurt/providers')
    const { setServers } = await import('../../src/main/ole/yogurt/servers')
    const file = join(mkdtempSync(join(tmpdir(), 'ole-bg-')), 'settings.json')
    writeSecret(file, 'openai', 'sk-test-123456')
    setProviders(file, { assistant: 'openai' })
    setServers(file, [{ id: 'crm', name: 'CRM', url: 'https://crm.example/mcp' }])
    const notify = vi.fn()
    const ole = hookOle({ file, send: () => {}, notify, checkEveryMs: 0 })
    await ole.checkServers(); await ole.checkServers()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toBe("Ole can't use CRM")
  })
  it('never contacts the servers when Ole would not use them (Assistant on Local)', async () => {
    const { hookOle } = await import('../../src/main/ole/yogurt/session')
    const { setProviders } = await import('../../src/main/ole/yogurt/providers')
    const { setServers } = await import('../../src/main/ole/yogurt/servers')
    const file = join(mkdtempSync(join(tmpdir(), 'ole-bg-')), 'settings.json')
    setProviders(file, { assistant: 'local' })
    setServers(file, [{ id: 'crm', name: 'CRM', url: 'https://crm.example/mcp' }])
    const notify = vi.fn()
    const ole = hookOle({ file, send: () => {}, notify, checkEveryMs: 0 })
    await ole.checkServers()
    expect(notify).not.toHaveBeenCalled()
  })
})
