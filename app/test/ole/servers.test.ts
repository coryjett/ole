import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>())
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from([...Buffer.from(s)].reverse()),
    decryptString: (b: Buffer) => Buffer.from([...b].reverse()).toString(),
  },
}))
import { hookOleServers, idFromName, isValidServerUrl, serversOf, setServers } from '../../src/main/ole/yogurt/servers'
import { readSecret, writeSecret } from '../../src/main/ole/yogurt/secrets'
import { loadSettings, updateSettings, type Settings } from '../../src/main/settings'

let dir = ''
let file = ''
const test = vi.fn(async (_server: unknown, _key: string | null): Promise<{ ok: boolean; tools: number; error?: string }> => ({ ok: true, tools: 3 }))
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ole-servers-')); file = join(dir, 'settings.json')
  test.mockClear()
  hookOleServers({ file, test })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }); handlers.clear() })

const call = (name: string, ...args: unknown[]) => handlers.get(name)!(null, ...args)

it('accepts only https URLs without credentials, spaces or excess length', () => {
  expect(isValidServerUrl('https://crm.example/mcp')).toBe(true)
  for (const bad of ['http://crm.example/mcp', 'https://user:pw@crm.example/mcp', 'https://u@crm.example/mcp', 'https://crm.example/ mcp',
    'ftp://x', 'not a url', '', `https://x.example/${'a'.repeat(300)}`, 42, null]) expect(isValidServerUrl(bad)).toBe(false)
})

it('generates ids from names, unique, and keeps given ids', () => {
  expect(idFromName('My CRM!')).toBe('my-crm')
  expect(idFromName('!!!')).toBe('server')
  const got = setServers(file, [
    { name: ' My CRM ', url: 'https://a.example/mcp' },
    { name: 'my crm', url: 'https://b.example/mcp', enabled: false },
    { id: 'docs', name: 'Docs', url: 'https://c.example/mcp' },
  ])
  expect(got).toEqual([
    { id: 'my-crm', name: 'My CRM', url: 'https://a.example/mcp', enabled: true },
    { id: 'my-crm-2', name: 'my crm', url: 'https://b.example/mcp', enabled: false },
    { id: 'docs', name: 'Docs', url: 'https://c.example/mcp', enabled: true },
  ])
  expect(serversOf(loadSettings(file))).toEqual(got)
  expect(call('ole:servers:get')).toEqual(got)
})

it('a generated id never takes an explicit id later in the list, and duplicate ids are dropped', () => {
  const got = setServers(file, [{ name: 'CRM', url: 'https://a.example/mcp' }, { id: 'crm', name: 'Other', url: 'https://b.example/mcp' }, { id: 'crm', name: 'Dup', url: 'https://c.example/mcp' }])
  expect(got.map((s) => s.id)).toEqual(['crm-2', 'crm'])
})

it('drops invalid entries', () => {
  const got = setServers(file, [
    { name: '', url: 'https://a.example/mcp' },
    { name: 'x'.repeat(41), url: 'https://a.example/mcp' },
    { name: 'Plain', url: 'http://a.example/mcp' },
    { name: 'Creds', url: 'https://k:v@a.example/mcp' },
    { id: 'Bad_Id', name: 'Bad', url: 'https://a.example/mcp' },
    { name: 'Flag', url: 'https://a.example/mcp', enabled: 'yes' },
    'string', null, [],
    { name: 'Good', url: ' https://good.example/mcp ' },
  ])
  expect(got).toEqual([{ id: 'good', name: 'Good', url: 'https://good.example/mcp', enabled: true }])
})

it('refuses more than 10 servers and a non-array', () => {
  const eleven = Array.from({ length: 11 }, (_, i) => ({ name: `S${i}`, url: 'https://a.example/mcp' }))
  expect(() => call('ole:servers:set', eleven)).toThrow(/At most 10/)
  expect(() => call('ole:servers:set', { name: 'x' })).toThrow('Invalid server list')
  expect(setServers(file, eleven.slice(0, 10))).toHaveLength(10)
})

it('a hand-edited file keeps only valid entries with ids', () => {
  const s = { oleMcpServers: [{ name: 'No id', url: 'https://a.example/mcp' }, { id: 'ok', name: 'OK', url: 'https://a.example/mcp' }, { id: 'h', name: 'H', url: 'http://a.example' }] } as unknown as Settings
  expect(serversOf(s)).toEqual([{ id: 'ok', name: 'OK', url: 'https://a.example/mcp', enabled: true }])
  expect(serversOf({})).toEqual([])
  expect(serversOf({ oleMcpServers: 'x' } as unknown as Settings)).toEqual([])
})

it('removing a server drops its sealed key and keeps the others', () => {
  setServers(file, [{ id: 'crm', name: 'CRM', url: 'https://a.example/mcp' }, { id: 'docs', name: 'Docs', url: 'https://b.example/mcp' }])
  writeSecret(file, 'mcp:crm', 'crm-key-123456')
  writeSecret(file, 'mcp:docs', 'docs-key-123456')
  writeSecret(file, 'openai', 'sk-test-123456')
  call('ole:servers:set', [{ id: 'docs', name: 'Docs', url: 'https://b.example/mcp' }])
  expect(readSecret(file, 'mcp:crm')).toBeNull()
  expect(readSecret(file, 'mcp:docs')).toBe('docs-key-123456')
  expect(readSecret(file, 'openai')).toBe('sk-test-123456')
  call('ole:servers:set', [])
  expect(readSecret(file, 'mcp:docs')).toBeNull()
  expect('oleMcpServers' in loadSettings(file)).toBe(false)
  expect(readFileSync(file, 'utf8')).not.toContain('docs-key')
})

it('a server pointed at a new address loses its key; a path change on the same origin keeps it', () => {
  setServers(file, [{ id: 'crm', name: 'CRM', url: 'https://a.example/mcp' }])
  writeSecret(file, 'mcp:crm', 'crm-key-123456')
  setServers(file, [{ id: 'crm', name: 'CRM', url: 'https://a.example/v2/mcp' }])
  expect(readSecret(file, 'mcp:crm')).toBe('crm-key-123456')
  setServers(file, [{ id: 'crm', name: 'CRM', url: 'https://evil.example/mcp' }])
  expect(readSecret(file, 'mcp:crm')).toBeNull()
})

it('test runs the injected tester with the server and its key', async () => {
  setServers(file, [{ id: 'crm', name: 'CRM', url: 'https://a.example/mcp' }])
  writeSecret(file, 'mcp:crm', 'crm-key-123456')
  expect(await call('ole:servers:test', 'crm')).toEqual({ ok: true, tools: 3 })
  expect(test).toHaveBeenCalledWith({ id: 'crm', name: 'CRM', url: 'https://a.example/mcp', enabled: true }, 'crm-key-123456')
})

it('test reports errors without throwing, and validates the id', async () => {
  setServers(file, [{ id: 'crm', name: 'CRM', url: 'https://a.example/mcp' }])
  test.mockResolvedValueOnce({ ok: false, tools: 0, error: 'Unauthorized' })
  expect(await call('ole:servers:test', 'crm')).toEqual({ ok: false, tools: 0, error: 'Unauthorized' })
  test.mockRejectedValueOnce(new Error('boom'))
  expect(await call('ole:servers:test', 'crm')).toEqual({ ok: false, tools: 0, error: 'boom' })
  expect(await call('ole:servers:test', 'nope')).toEqual({ ok: false, tools: 0, error: 'No such server' })
  await expect(call('ole:servers:test', '../x')).rejects.toThrow('Invalid server')
  await expect(call('ole:servers:test', 7)).rejects.toThrow('Invalid server')
  expect(test).toHaveBeenCalledTimes(2)
  expect(test.mock.calls[0][1]).toBeNull()
})

it('keeps other settings when saving servers', () => {
  updateSettings(file, { theme: 'dark' })
  setServers(file, [{ name: 'CRM', url: 'https://a.example/mcp' }])
  expect(loadSettings(file).theme).toBe('dark')
})
