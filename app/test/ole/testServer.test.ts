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
  it('gives up quickly on a server that never answers (unreachable)', async () => {
    const hang = vi.fn<typeof fetch>((_u, init) => new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))))
    const started = Date.now()
    const r = await testServer(server, 'k-123456', { fetch: hang, timeoutMs: 50 })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Couldn't reach the server in \d+ s\. Check its address\./)
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('the tool list Test returns (#1)', () => {
  it('lists only the read-only tools, sorted, with descriptions', async () => {
    const tools = [
      { name: 'search_calls', description: 'Search calls', inputSchema: { type: 'object' } },
      { name: 'add_note', description: 'Add a note', inputSchema: { type: 'object' } },
      { name: 'get_account_details', description: 'Account', inputSchema: { type: 'object' } },
    ]
    const f = vi.fn<typeof fetch>(async (_u, init) => {
      const req = JSON.parse(String(init?.body))
      if (req.id === undefined) return new Response(null, { status: 202 })
      const result = req.method === 'tools/list' ? { tools } : { protocolVersion: '2025-06-18', capabilities: { tools: {} } }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const r = await testServer(server, 'k-123456', { fetch: f })
    expect(r.ok).toBe(true)
    expect(r.toolList?.map(t => t.name)).toEqual(['get_account_details', 'search_calls'])
    expect(r.tools).toBe(2)
  })
})
