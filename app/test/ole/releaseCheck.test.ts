import { describe, expect, it } from 'vitest'
// @ts-expect-error a plain .mjs script, checked by its tests
import { compareVersions, feedProblems, parseLatestYml } from '../../scripts/release-check.mjs'

const yml = `version: 0.1.0-alpha.11
files:
  - url: Ole-mac-arm64.zip
    sha512: abc==
    size: 100
  - url: Ole-mac-arm64.dmg
    sha512: def==
    size: 200
path: Ole-mac-arm64.zip
sha512: abc==
releaseDate: '2026-11-20T01:00:00.000Z'
`
const assets = [{ name: 'Ole-mac-arm64.zip', size: 100 }, { name: 'Ole-mac-arm64.dmg', size: 200 }, { name: 'latest-mac.yml', size: 300 }]

describe('release checks (#26)', () => {
  it('orders versions the way the updater does, pre-releases included', () => {
    expect(compareVersions('0.1.0-alpha.10', '0.1.0-alpha.9')).toBeGreaterThan(0)
    expect(compareVersions('0.1.0', '0.1.0-alpha.10')).toBeGreaterThan(0)
    expect(compareVersions('0.1.0-beta.1', '0.1.0-alpha.12')).toBeGreaterThan(0)
    expect(compareVersions('v0.1.0-alpha.10', '0.1.0-alpha.10')).toBe(0)
    expect(compareVersions('0.1.1-alpha.1', '0.1.0')).toBeGreaterThan(0)
  })
  it('reads latest-mac.yml', () => {
    const y = parseLatestYml(yml)
    expect(y.version).toBe('0.1.0-alpha.11')
    expect(y.path).toBe('Ole-mac-arm64.zip')
    expect(y.files).toEqual([{ url: 'Ole-mac-arm64.zip', sha512: 'abc==', size: 100 }, { url: 'Ole-mac-arm64.dmg', sha512: 'def==', size: 200 }])
  })
  it('a complete release has no problems', () => {
    expect(feedProblems(parseLatestYml(yml), assets, 'v0.1.0-alpha.11')).toEqual([])
  })
  it('catches a missing upload, a wrong size, the wrong version and no zip', () => {
    expect(feedProblems(parseLatestYml(yml), assets.filter(a => !a.name.endsWith('.zip')), 'v0.1.0-alpha.11')).toContain('Ole-mac-arm64.zip is listed in latest-mac.yml but not uploaded')
    expect(feedProblems(parseLatestYml(yml), [{ name: 'Ole-mac-arm64.zip', size: 99 }, assets[1]], 'v0.1.0-alpha.11')[0]).toMatch(/99 bytes/)
    expect(feedProblems(parseLatestYml(yml), assets, 'v0.1.0-alpha.12')[0]).toMatch(/says 0.1.0-alpha.11/)
    expect(feedProblems(parseLatestYml(yml.replace(/Ole-mac-arm64\.zip/g, 'Ole.dmg2')), assets, 'v0.1.0-alpha.11')).toContain('latest-mac.yml lists no .zip (the Mac updater installs the zip)')
  })
})

describe('verify fails closed (#26)', () => {
  it('refuses to run without a 40-character signing identity', async () => {
    // @ts-expect-error a plain .mjs script
    const { verifyRelease } = await import('../../scripts/release-check.mjs')
    expect(() => verifyRelease('coryjett/ole', 'v0.1.0', '')).toThrow(/signing identity/)
    expect(() => verifyRelease('coryjett/ole', 'v0.1.0', 'abc')).toThrow(/signing identity/)
  })
})
