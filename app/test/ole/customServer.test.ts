import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (n: string, f: (...a: unknown[]) => unknown) => handlers.set(n, f) },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
}))
const { openaiChat, OLE_USER_AGENT } = await import('../../src/main/ole/openaiModel')
const { listOpenAIModels } = await import('../../src/main/ole/openaiTest')
const { setProviders, providersOf } = await import('../../src/main/ole/providers')
const { loadSettings } = await import('../../src/main/settings')
const { hookOle } = await import('../../src/main/ole/session')
const { CustomServerRows } = await import('../../src/renderer/src/ole/OleSettings')

const ok = () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' } }] }), { status: 200 })
let file = ''
beforeEach(() => { file = join(mkdtempSync(join(tmpdir(), 'ole-custom-')), 'settings.json'); handlers.clear() })

describe('Custom server (#17)', () => {
  it('chat goes to the server address, with a non-default User-Agent and no key header when there is no key', async () => {
    const f = vi.fn<typeof fetch>(async () => ok())
    await openaiChat({ key: '', baseUrl: 'https://models.example.com/v1', model: 'default', messages: [{ role: 'user', content: 'q' }], fetch: f })
    const [url, init] = f.mock.calls[0]
    expect(url).toBe('https://models.example.com/v1/chat/completions')
    const h = init?.headers as Record<string, string>
    expect(h['User-Agent']).toBe(OLE_USER_AGENT)
    expect('Authorization' in h).toBe(false)
  })
  it('OpenAI itself still needs a key', async () => {
    await expect(openaiChat({ key: '', model: 'gpt-5.6-luna', messages: [{ role: 'user', content: 'q' }], fetch: vi.fn() })).rejects.toThrow('Add an OpenAI key')
  })
  it("lists every model a custom server serves, not only gpt-style names", async () => {
    const f = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: [{ id: 'qwen3-flash' }, { id: 'llama-4' }] }), { status: 200 }))
    const r = await listOpenAIModels({ key: null, baseUrl: 'https://models.example.com/v1', fetch: f })
    expect(r.chat.sort()).toEqual(['llama-4', 'qwen3-flash'])
  })
  it('settings take only an https address; an empty model means the server default', () => {
    setProviders(file, { assistant: 'custom', customBaseUrl: 'http://models.example.com/v1' })
    expect(providersOf(loadSettings(file))).toMatchObject({ assistant: 'custom', customBaseUrl: '', customModel: '' })
    setProviders(file, { customBaseUrl: 'https://models.example.com/v1', customModel: 'qwen3-flash' })
    expect(providersOf(loadSettings(file))).toMatchObject({ customBaseUrl: 'https://models.example.com/v1', customModel: 'qwen3-flash' })
  })
  it('Prepare and live context run with Custom server once its address is set, and say so until then', async () => {
    setProviders(file, { assistant: 'custom' })
    hookOle({ file, send: () => {} })
    expect((await handlers.get('ole:state')!({}) as { blocked: string | null }).blocked).toContain('Custom server address')
    setProviders(file, { customBaseUrl: 'https://models.example.com/v1' })
    expect((await handlers.get('ole:state')!({}) as { blocked: string | null }).blocked).toBeNull()
  })
  it('Settings shows the address, key, Test and a model picker with Server default', () => {
    const providers = { ...providersOf({}), assistant: 'custom' as const, customBaseUrl: 'https://models.example.com/v1' }
    const html = renderToStaticMarkup(createElement(CustomServerRows, { api: { customModels: async () => ({ ok: true, chat: [], transcribe: [] }), testCustom: async () => ({ ok: true }) }, providers, saveKey: async () => true, disabled: false, patch: () => {} }))
    expect(html).toContain('Custom server address')
    expect(html).toContain('value="https://models.example.com/v1"')
    expect(html).toContain('data-testid="ole-custom-test"')
    expect(html).toContain('Server default')
  })
})
