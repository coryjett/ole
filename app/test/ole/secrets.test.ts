import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>())
const keychain = vi.hoisted(() => ({ available: true }))
vi.mock('electron', () => ({
  app: { getPreferredSystemLanguages: () => ['en-US'] },
  ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) },
  BrowserWindow: {}, nativeTheme: {},
  // reversible stand-in for the keychain: reversed bytes, so the plain text never appears as is
  safeStorage: {
    isEncryptionAvailable: () => keychain.available,
    encryptString: (s: string) => Buffer.from([...Buffer.from(s)].reverse()),
    decryptString: (b: Buffer) => Buffer.from([...b].reverse()).toString(),
  },
}))
import { hookOleSecrets, isSecretName, maskSecret, openSecret, readSecret, removeSecret, sealSecret, secretStatus, writeSecret } from '../../src/main/ole/secrets'
import { hookPreferences } from '../../src/main/preferences'
import { loadSettings, updateSettings } from '../../src/main/settings'

let dir = ''
let file = ''
beforeEach(() => { keychain.available = true; dir = mkdtempSync(join(tmpdir(), 'ole-secrets-')); file = join(dir, 'settings.json'); hookOleSecrets({ file }) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }); handlers.clear() })

const set = (name: unknown, value: unknown) => handlers.get('ole:secret:set')!(null, name, value)
const status = (names?: unknown) => handlers.get('ole:secret:status')!(null, names)

it('stores keys sealed, never in plain text', () => {
  updateSettings(file, { theme: 'dark' })
  set('openai', 'sk-test-123456')
  const raw = readFileSync(file, 'utf8')
  expect(raw).not.toContain('sk-test')
  expect(raw).not.toContain('123456')
  expect((loadSettings(file) as { oleSecrets?: Record<string, string> }).oleSecrets?.openai).toMatch(/^k:/)
  expect(loadSettings(file).theme).toBe('dark')
})

it('readSecret returns the plain key in the main process', () => {
  set('mcp:crm', '  mcp-key-abcdef  ')
  expect(readSecret(file, 'mcp:crm')).toBe('mcp-key-abcdef')
  expect(readSecret(file, 'openai')).toBeNull()
  expect(openSecret(sealSecret('x'))).toBe('x')
  expect(openSecret('b:eA==')).toBeNull()
})

it('status is masked and never holds the key', () => {
  const after = set('openai', 'sk-test-123456')
  expect(after).toEqual({ openai: { set: true, masked: 'sk-…3456' } })
  expect(status()).toEqual(after)
  expect(status(['openai', 'mcp:crm'])).toEqual({ openai: { set: true, masked: 'sk-…3456' }, 'mcp:crm': { set: false, masked: '' } })
  expect(JSON.stringify(status())).not.toContain('sk-test-123456')
  expect(maskSecret('')).toBe('')
  expect(maskSecret('short')).toBe('…rt')
})

it('settings:get never includes a sealed or plain key', () => {
  set('openai', 'sk-test-123456')
  hookPreferences({ file, permissions: {} as Parameters<typeof hookPreferences>[0]['permissions'], ask: false, setLogin() {}, loginOn: () => false, macName: () => '', relaunch: () => false, setTrayVisible() {}, setDockVisible() {} })
  const got = JSON.stringify(handlers.get('settings:get')!())
  expect(got).not.toContain('oleSecrets')
  expect(got).not.toContain('k:')
  expect(got).not.toContain('sk-test')
})

it('an empty value clears the key', () => {
  set('openai', 'sk-test-123456')
  set('mcp:crm', 'mcp-key-abcdef')
  expect(set('openai', '').openai).toEqual({ set: false, masked: '' })
  expect(readSecret(file, 'openai')).toBeNull()
  expect(readSecret(file, 'mcp:crm')).toBe('mcp-key-abcdef')
  writeSecret(file, 'mcp:crm', '')
  expect('oleSecrets' in loadSettings(file)).toBe(false)
})

it('refuses to store when safeStorage is unavailable', () => {
  updateSettings(file, { theme: 'light' })
  const before = readFileSync(file, 'utf8')
  keychain.available = false
  expect(() => set('openai', 'sk-test-123456')).toThrow(/Secure storage/)
  expect(readFileSync(file, 'utf8')).toBe(before)
  expect(secretStatus(file, ['openai']).openai?.set).toBe(false)
})

it('rejects unknown names and non-string values', () => {
  expect(() => set('anthropic', 'x')).toThrow('Invalid secret')
  expect(() => set('openai', 42)).toThrow('Invalid secret')
  for (const bad of ['mcp', 'mcp:', 'mcp:Upper', 'mcp:a_b', 'mcp:../x', `mcp:${'a'.repeat(41)}`, 'oleSecrets', 7, null]) {
    expect(isSecretName(bad)).toBe(false)
    expect(() => set(bad, 'x')).toThrow('Invalid secret')
  }
  expect(isSecretName(`mcp:${'a'.repeat(40)}`)).toBe(true)
  expect(isSecretName('mcp:crm-2')).toBe(true)
  expect(() => writeSecret(file, 'mcp:Bad' as never, 'x')).toThrow('Invalid secret')
  expect(readSecret(file, 'mcp:Bad' as never)).toBeNull()
})

it('status names from IPC are validated', () => {
  expect(() => status(['openai', 'mcp:Bad'])).toThrow('Invalid secret')
  expect(() => status('openai')).toThrow('Invalid secret')
  expect(() => status(Array.from({ length: 21 }, (_, i) => `mcp:s${i}`))).toThrow('Invalid secret')
  expect(() => secretStatus(file, ['nope' as never])).toThrow('Invalid secret')
})

it('the default status covers the OpenAI key and every configured server', () => {
  updateSettings(file, { oleMcpServers: [{ id: 'crm', name: 'CRM', url: 'https://crm.example/mcp', enabled: true }, { id: 'docs', name: 'Docs', url: 'https://docs.example/mcp', enabled: false }] })
  set('mcp:crm', 'crm-key-123456789')
  expect(status()).toEqual({ openai: { set: false, masked: '' }, 'mcp:crm': { set: true, masked: 'crm…6789' }, 'mcp:docs': { set: false, masked: '' } })
  expect(JSON.stringify(status())).not.toContain('crm-key')
})

it('removeSecret drops one key and works without the keychain', () => {
  set('openai', 'sk-test-123456')
  set('mcp:crm', 'crm-key-123456789')
  keychain.available = false
  removeSecret(file, 'mcp:crm')
  removeSecret(file, 'mcp:none')
  keychain.available = true
  expect(readSecret(file, 'mcp:crm')).toBeNull()
  expect(readSecret(file, 'openai')).toBe('sk-test-123456')
  removeSecret(file, 'openai')
  expect('oleSecrets' in loadSettings(file)).toBe(false)
  expect(() => removeSecret(file, 'mcp:Bad' as never)).toThrow('Invalid secret')
})
