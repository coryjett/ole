// Ole on Yogurt: the provider settings (core/providers.ts) over Yogurt's settings file, and their IPC.
import { ipcMain } from 'electron'
import type { OleProviders } from '../core/types'
import { adoptOpenAI as adopt, PROVIDER_DEFAULTS, providersOf, revertOpenAI as revert } from '../core/providers'
import { providerHandlers } from '../core/settingsHandlers'
import { fileSecrets, fileSettings } from './settingsFile'

export { PROVIDER_DEFAULTS, providersOf }

/** told after Settings change the providers, so the windows follow "hide while sharing" at once (#51) */
let changed: ((p: OleProviders) => void) | undefined

const handlers = (file: string) => providerHandlers({ settings: fileSettings(file), secrets: fileSecrets(file), onChange: p => changed?.(p) })

export const setProviders = (file: string, patch: unknown): OleProviders => handlers(file).set(patch)
export const adoptOpenAI = (file: string) => adopt(fileSettings(file))
export const revertOpenAI = (file: string, o: { undo: boolean }) => revert(fileSettings(file), o)

export function hookOleProviders(d: { file: string; onChange?: (p: OleProviders) => void }): void {
  changed = d.onChange
  const h = handlers(d.file)
  ipcMain.handle('ole:providers:get', () => h.get())
  ipcMain.handle('ole:providers:set', (_e, patch: unknown) => h.set(patch))
  ipcMain.handle('ole:openai:test', () => h.openaiTest())
  ipcMain.handle('ole:openai:adopt', () => h.openaiAdopt())
  ipcMain.handle('ole:openai:revert', (_e, undo: unknown) => h.openaiRevert(undo))
  ipcMain.handle('ole:openai:models', () => h.openaiModels())
  ipcMain.handle('ole:custom:models', () => h.customModels())
  ipcMain.handle('ole:custom:test', () => h.customTest())
}
