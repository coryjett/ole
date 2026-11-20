import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('electron', () => { const app = { getPath: (name: string) => `/fake/${name}` }; return { app, default: { app } } })
const { userDataDir } = await import('../../src/main/paths')
const { brand } = await import('../../src/shared/brand')
const { setLanguage, t } = await import('../../src/shared/i18n')

const root = join(__dirname, '../..')
// Windows checks the file out with CRLF line endings
const read = (path: string) => readFileSync(join(root, path), 'utf8').replaceAll('\r\n', '\n')

afterEach(() => setLanguage('en'))

it('brand() swaps the product name in user text only', () => {
  expect(brand('Open Yogurt')).toBe('Open Ole')
  expect(brand('Quit Yogurt')).toBe('Quit Ole')
  expect(brand("Yogurt's folder")).toBe("Ole's folder")
  expect(brand('yogurt-audio')).toBe('yogurt-audio')
  expect(brand('YogurtX')).toBe('YogurtX')
})

it('t() returns branded text for any locale', () => {
  setLanguage('en')
  expect(t('Open Yogurt')).toBe('Open Ole')
  setLanguage('de')
  expect(t('Open Yogurt')).not.toMatch(/\bYogurt\b/)
})

it('data folder is Ole, never Yogurt', () => {
  delete process.env.YOGURT_USER_DATA
  expect(userDataDir()).toBe(join('/fake/appData', 'Ole'))
})

it('builder config identifies as Ole', () => {
  const config = read('electron-builder.yml')
  expect(config).toMatch(/^appId: net\.cjett\.ole$/m)
  expect(config).toMatch(/^productName: Ole$/m)
  expect(config).toContain('artifactName: Ole-mac-${arch}.${ext}')
  expect(config).not.toContain('so.yogurt.app')
})

it('helper bundle ids and the MCP helper path are Ole', () => {
  for (const [dir, id] of [['yogurt-audio', 'net.cjett.ole.audio-helper'], ['yogurt-mac', 'net.cjett.ole.mac-helper'], ['yogurt-mcp', 'net.cjett.ole.mcp']]) {
    expect(read(`native/${dir}/Info.plist`)).toContain(`<key>CFBundleIdentifier</key><string>${id}</string>`)
  }
  const swift = read('native/yogurt-mcp/main.swift')
  expect(swift).toContain('Application Support/Ole"')
  expect(swift).toContain('"net.cjett.ole"')
  expect(swift).not.toContain('so.yogurt.app')
  expect(swift).not.toContain('Application Support/Yogurt')
})
