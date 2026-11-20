// Ole on Yogurt: API keys sealed with the system keychain (safeStorage) in Yogurt's settings file. No plain fallback; the
// renderer only ever sees masked status. Names, masking and status are the core's (core/secrets.ts).
import { ipcMain, safeStorage } from 'electron'
import { loadSettings, updateSettings, type Settings } from '../../settings'
import { defaultSecretNames as defaults, isSecretName, maskSecret, secretStatus as status, SERVER_ID, type SecretStatus } from '../core/secrets'
import { secretHandlers } from '../core/settingsHandlers'
import { fileSettings } from './settingsFile'
import type { SecretName } from '../core/types'

export { isSecretName, maskSecret, SERVER_ID, type SecretStatus }

type OleSettings = Settings & { oleSecrets?: Partial<Record<SecretName, string>> }

/** the names Settings asks about by default: the OpenAI key and one per configured server */
export const defaultSecretNames = (file: string): SecretName[] => defaults(loadSettings(file))

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

export const secretStatus = (file: string, names: SecretName[]): SecretStatus => status((name) => readSecret(file, name), names)

export function hookOleSecrets(d: { file: string }): void {
  const h = secretHandlers({ settings: fileSettings(d.file), secrets: { read: (n) => readSecret(d.file, n), write: (n, v) => writeSecret(d.file, n, v), remove: (n) => removeSecret(d.file, n) } })
  ipcMain.handle('ole:secret:set', (_e, name: unknown, value: unknown) => h.set(name, value))
  ipcMain.handle('ole:secret:status', (_e, names?: unknown) => h.status(names))
}
