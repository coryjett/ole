import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
const power = new EventEmitter()
vi.mock('electron', () => ({
  app: { getVersion: () => '0.1.0-alpha.27', quit: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: (name: string, fn: (...a: unknown[]) => unknown) => handlers.set(name, fn) },
  Notification: { isSupported: () => false },
  powerMonitor: power,
}))
const updater = Object.assign(new EventEmitter(), { autoDownload: false, autoInstallOnAppQuit: false, logger: undefined, checkForUpdates: vi.fn(async () => {}) })
vi.mock('electron-updater', () => ({ default: { autoUpdater: updater } }))

const state = () => handlers.get('updates:status')!() as { state: string; next?: string }

it('pre-release builds check every 15 minutes; releases every 4 hours (#101)', async () => {
  const { checkEveryMs } = await import('../src/main/updates')
  expect(checkEveryMs('0.1.0-alpha.27')).toBe(15 * 60_000)
  expect(checkEveryMs('1.2.0')).toBe(4 * 60 * 60_000)
})

it('keeps checking after an update is ready, never hides it, and a newer one replaces it; wake checks too (#101)', async () => {
  vi.useFakeTimers()
  const { hookUpdates } = await import('../src/main/updates')
  const file = join(mkdtempSync(join(tmpdir(), 'ole-updates-')), 'settings.json')
  await hookUpdates({ file, available: true, recording: () => false })
  updater.emit('update-downloaded', { version: '0.1.0-alpha.28' })
  expect(state()).toMatchObject({ state: 'ready', next: '0.1.0-alpha.28' })
  vi.advanceTimersByTime(30_000)
  updater.checkForUpdates.mockClear()
  vi.advanceTimersByTime(15 * 60_000)
  expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
  updater.emit('checking-for-update')
  updater.emit('update-not-available')
  updater.emit('error', new Error('offline'))
  expect(state()).toMatchObject({ state: 'ready', next: '0.1.0-alpha.28' })
  updater.emit('update-available', { version: '0.1.0-alpha.29' })
  expect(state()).toMatchObject({ state: 'ready', next: '0.1.0-alpha.28' })
  updater.emit('update-downloaded', { version: '0.1.0-alpha.29' })
  expect(state()).toMatchObject({ state: 'ready', next: '0.1.0-alpha.29' })
  updater.checkForUpdates.mockClear()
  power.emit('resume')
  expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
  vi.useRealTimers()
})
