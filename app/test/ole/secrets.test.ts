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
import { hookOleSecrets, maskSecret, openSecret, readSecret, sealSecret, secretStatus, writeSecret } from '../../src/main/ole/secrets'
import { hookPreferences } from '../../src/main/preferences'
import { loadSettings, updateSettings } from '../../src/main/settings'

let dir = ''
let file = ''
beforeEach(() => { keychain.available = true; dir = mkdtempSync(join(tmpdir(), 'ole-secrets-')); file = join(dir, 'settings.json'); hookOleSecrets({ file }) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }); handlers.clear() })

const set = (name: unknown, value: unknown) => handlers.get('ole:secret:set')!(null, name, value)
const status = () => handlers.get('ole:secret:status')!()

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
  set('mcp', '  mcp-key-abcdef  ')
  expect(readSecret(file, 'mcp')).toBe('mcp-key-abcdef')
  expect(readSecret(file, 'openai')).toBeNull()
  expect(openSecret(sealSecret('x'))).toBe('x')
  expect(openSecret('b:eA==')).toBeNull()
})

it('status is masked and never holds the key', () => {
  const after = set('openai', 'sk-test-123456')
  expect(after).toEqual({ openai: { set: true, masked: 'sk-…3456' }, mcp: { set: false, masked: '' } })
  expect(status()).toEqual(after)
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
  set('mcp', 'mcp-key-abcdef')
  expect(set('openai', '').openai).toEqual({ set: false, masked: '' })
  expect(readSecret(file, 'openai')).toBeNull()
  expect(readSecret(file, 'mcp')).toBe('mcp-key-abcdef')
  writeSecret(file, 'mcp', '')
  expect('oleSecrets' in loadSettings(file)).toBe(false)
})

it('refuses to store when safeStorage is unavailable', () => {
  updateSettings(file, { theme: 'light' })
  const before = readFileSync(file, 'utf8')
  keychain.available = false
  expect(() => set('openai', 'sk-test-123456')).toThrow(/Secure storage/)
  expect(readFileSync(file, 'utf8')).toBe(before)
  expect(secretStatus(file).openai.set).toBe(false)
})

it('rejects unknown names and non-string values', () => {
  expect(() => set('anthropic', 'x')).toThrow('Invalid secret')
  expect(() => set('openai', 42)).toThrow('Invalid secret')
})
