// Ole: API keys sealed with the system keychain (safeStorage). No plain fallback; the renderer only ever sees masked status.
import { ipcMain, safeStorage } from 'electron'
import { loadSettings, updateSettings, type Settings } from '../../settings'
import { serversOf } from './servers'
import type { SecretName } from '../core/types'

type OleSettings = Settings & { oleSecrets?: Partial<Record<SecretName, string>> }
export type SecretStatus = Partial<Record<SecretName, { set: boolean; masked: string }>>

/** an MCP server id: lowercase letters, digits and dashes, 1 to 40 characters */
export const SERVER_ID = /^[a-z0-9-]{1,40}$/

/** 'openai', 'custom' (the Custom server's key, #17), or `mcp:<id>` for an MCP server's key */
export function isSecretName(name: unknown): name is SecretName {
  if (name === 'openai' || name === 'custom') return true
  return typeof name === 'string' && name.startsWith('mcp:') && SERVER_ID.test(name.slice(4))
}

/** the names Settings asks about by default: the OpenAI key and one per configured server */
export function defaultSecretNames(file: string): SecretName[] {
  return ['openai', ...serversOf(loadSettings(file)).map((s) => `mcp:${s.id}` as SecretName)]
}

export function sealSecret(plain: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure storage is not available on this computer')
  }
  return 'k:' + safeStorage.encryptString(plain).toString('base64')
}

export function openSecret(sealed: string): string | null {
  if (!sealed.startsWith('k:') || !safeStorage.isEncryptionAvailable()) {
    return null
  }
  try {
    const encrypted = Buffer.from(sealed.slice(2), 'base64')
    return safeStorage.decryptString(encrypted)
  } catch {
    return null
  }
}

export function readSecret(file: string, name: SecretName): string | null {
  if (!isSecretName(name)) return null
  const settings = loadSettings(file) as OleSettings
  const sealed = settings.oleSecrets?.[name]
  if (!sealed) return null
  return openSecret(sealed)
}

export function writeSecret(file: string, name: SecretName, value: string): void {
  if (!isSecretName(name)) throw new Error('Invalid secret')
  const trimmed = value.trim()
  const settings = loadSettings(file) as OleSettings
  let oleSecrets: Partial<Record<SecretName, string>> | undefined = { ...(settings.oleSecrets ?? {}) }

  if (trimmed === '') {
    delete oleSecrets[name]
    if (Object.keys(oleSecrets).length === 0) {
      oleSecrets = undefined
    }
  } else {
    // seal before writing, so a refusal leaves the file untouched
    oleSecrets[name] = sealSecret(trimmed)
  }

  updateSettings(file, { oleSecrets } as Partial<OleSettings>)
}

/** drops a sealed key; needs no keychain, so it works even where sealing is refused */
export function removeSecret(file: string, name: SecretName): void {
  if (!isSecretName(name)) throw new Error('Invalid secret')
  const settings = loadSettings(file) as OleSettings
  if (!settings.oleSecrets || !(name in settings.oleSecrets)) return
  const oleSecrets: Partial<Record<SecretName, string>> = { ...settings.oleSecrets }
  delete oleSecrets[name]
  updateSettings(file, { oleSecrets: Object.keys(oleSecrets).length ? oleSecrets : undefined } as Partial<OleSettings>)
}

export function maskSecret(plain: string): string {
  if (plain === '') return ''
  if (plain.length <= 8) return '…' + plain.slice(-2)
  return plain.slice(0, 3) + '…' + plain.slice(-4)
}

export function secretStatus(file: string, names: SecretName[]): SecretStatus {
  const status: SecretStatus = {}
  for (const name of names) {
    if (!isSecretName(name)) throw new Error('Invalid secret')
    const plain = readSecret(file, name)
    status[name] = plain ? { set: true, masked: maskSecret(plain) } : { set: false, masked: '' }
  }
  return status
}

/** names from the renderer: an array of valid names, at most 20; undefined means the defaults */
function namesFrom(file: string, names: unknown): SecretName[] {
  if (names === undefined || names === null) return defaultSecretNames(file)
  if (!Array.isArray(names) || names.length > 20 || !names.every(isSecretName)) throw new Error('Invalid secret')
  return [...new Set(names)]
}

export function hookOleSecrets(d: { file: string }): void {
  ipcMain.handle('ole:secret:set', (_e, name: unknown, value: unknown) => {
    if (!isSecretName(name) || typeof value !== 'string') {
      throw new Error('Invalid secret')
    }
    writeSecret(d.file, name, value)
    return secretStatus(d.file, [...new Set([...defaultSecretNames(d.file), name])])
  })

  ipcMain.handle('ole:secret:status', (_e, names?: unknown) => secretStatus(d.file, namesFrom(d.file, names)))
}
