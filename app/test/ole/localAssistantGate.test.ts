import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (n: string, f: (...a: unknown[]) => unknown) => handlers.set(n, f) },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
}))
const openaiChat = vi.fn()
vi.mock('../../src/main/ole/openaiModel', () => ({ openaiChat }))
const { hookOle } = await import('../../src/main/ole/session')
const { writeSecret } = await import('../../src/main/ole/secrets')
const { setProviders } = await import('../../src/main/ole/providers')
const { setServers } = await import('../../src/main/ole/servers')

describe('Assistant on Local turns Prepare and live context off (#11)', () => {
  it('refuses to prepare and says why, even with an OpenAI key and a server saved', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ole-gate-')), 'settings.json')
    writeSecret(file, 'openai', 'sk-test-123456')
    setServers(file, [{ id: 'crm', name: 'CRM', url: 'https://crm.example/mcp' }])
    setProviders(file, { assistant: 'local' })
    const fetch = vi.spyOn(globalThis, 'fetch')
    hookOle({ file, send: () => {} })
    const s = await handlers.get('ole:prepare')!({}, {}) as { blocked: string | null; prepared: unknown; preparing: boolean }
    expect(s.blocked).toContain('Set Assistant to OpenAI')
    expect(s.prepared).toBeNull()
    expect(openaiChat).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
  it('with Assistant on OpenAI and a key, nothing is blocked', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ole-gate-')), 'settings.json')
    writeSecret(file, 'openai', 'sk-test-123456')
    setProviders(file, { assistant: 'openai' })
    handlers.clear()
    hookOle({ file, send: () => {} })
    expect((await handlers.get('ole:state')!({}) as { blocked: string | null }).blocked).toBeNull()
  })
})
