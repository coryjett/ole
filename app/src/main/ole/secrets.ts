// Ole: API keys sealed with the system keychain (safeStorage). No plain fallback; the renderer only ever sees masked status.
import { ipcMain, safeStorage } from 'electron'
import { loadSettings, updateSettings, type Settings } from '../settings'
import type { SecretName } from './types'

type OleSettings = Settings & { oleSecrets?: Partial<Record<SecretName, string>> }

export const SECRET_NAMES: SecretName[] = ['openai', 'siesta']

function isSecretName(name: unknown): name is SecretName {
  return typeof name === 'string' && SECRET_NAMES.includes(name as SecretName)
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
  const settings = loadSettings(file) as OleSettings
  const sealed = settings.oleSecrets?.[name]
  if (!sealed) return null
  return openSecret(sealed)
}

export function writeSecret(file: string, name: SecretName, value: string): void {
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

export function maskSecret(plain: string): string {
  if (plain === '') return ''
  if (plain.length <= 8) return '…' + plain.slice(-2)
  return plain.slice(0, 3) + '…' + plain.slice(-4)
}

export function secretStatus(file: string): Record<SecretName, { set: boolean; masked: string }> {
  const status = {} as Record<SecretName, { set: boolean; masked: string }>
  for (const name of SECRET_NAMES) {
    const plain = readSecret(file, name)
    if (!plain) {
      status[name] = { set: false, masked: '' }
    } else {
      status[name] = { set: true, masked: maskSecret(plain) }
    }
  }
  return status
}

export function hookOleSecrets(d: { file: string }): void {
  ipcMain.handle('ole:secret:set', (_e, name: unknown, value: unknown) => {
    if (!isSecretName(name) || typeof value !== 'string') {
      throw new Error('Invalid secret')
    }
    writeSecret(d.file, name, value)
    return secretStatus(d.file)
  })

  ipcMain.handle('ole:secret:status', () => secretStatus(d.file))
}
