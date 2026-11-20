import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, safeStorage: { isEncryptionAvailable: () => false } }))
const { testServer } = await import('../../src/main/ole/session')

const server = { id: 'crm', name: 'CRM', url: 'https://crm.example/mcp', enabled: true }
const status = (n: number) => vi.fn<typeof fetch>(async () => new Response('', { status: n }))

describe("Settings' Test button", () => {
  it('asks for a key when the server needs one and none is saved', async () => {
    expect(await testServer(server, null, { fetch: status(401) })).toEqual({ ok: false, tools: 0, error: 'The server needs a key: paste it and Save, then Test' })
  })
  it('says the key was rejected when one is saved', async () => {
    expect((await testServer(server, 'k-123456', { fetch: status(401) })).error).toBe('The server rejected the key')
  })
  it('gives up quickly on a server that never answers (VPN off)', async () => {
    const hang = vi.fn<typeof fetch>((_u, init) => new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))))
    const started = Date.now()
    const r = await testServer(server, 'k-123456', { fetch: hang, timeoutMs: 50 })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Couldn't reach the server in \d+ s\. VPN on\?/)
    expect(Date.now() - started).toBeLessThan(2000)
  })
})
