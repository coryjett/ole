// Ole on Yogurt: Ole's settings live in Yogurt's settings.json, its keys sealed there with the system keychain.
import type { SecretStore, SettingsStore } from '../core/host'
import { loadSettings, updateSettings, type Settings } from '../../settings'
import { readSecret, removeSecret, writeSecret } from './secrets'

/** the core's view of Yogurt's settings file, read fresh on every call */
export const fileSettings = (file: string): SettingsStore => ({
  get: () => loadSettings(file),
  patch: (patch) => updateSettings(file, patch as Partial<Settings>),
})

/** the core's view of the sealed keys in Yogurt's settings file */
export const fileSecrets = (file: string): SecretStore => ({
  read: (name) => readSecret(file, name),
  write: (name, value) => writeSecret(file, name, value),
  remove: (name) => removeSecret(file, name),
})
