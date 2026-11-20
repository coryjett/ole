// Ole's core (src/main/ole/core/) must run in any host (#97): no Electron, nothing from the host app. A file there may
// import only other core files, Node built-ins (node:*) and the app's npm dependencies.
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

const core = resolve(__dirname, '../../src/main/ole/core')
const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as { dependencies?: Record<string, string> }
const deps = new Set(Object.keys(pkg.dependencies ?? {}))

const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : /\.(ts|tsx|mts|js|mjs)$/.test(e.name) ? [join(dir, e.name)] : [])

/** every module a file names: static imports and re-exports (type-only too), import() and require() */
export function specifiers(src: string): string[] {
  const out: string[] = []
  for (const re of [/^\s*(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/gm, /^\s*import\s*['"]([^'"]+)['"]/gm, /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g])
    for (const m of src.matchAll(re)) out.push(m[1])
  return out
}

/** why a specifier is not allowed in core, or null */
function refused(file: string, spec: string): string | null {
  if (spec === 'electron' || spec.startsWith('electron/')) return 'imports electron'
  if (spec.startsWith('.')) {
    const target = resolve(dirname(file), spec)
    return target === core || target.startsWith(core + sep) ? null : `leaves core/ (${relative(core, target)})`
  }
  if (spec.startsWith('node:')) return null
  const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
  return deps.has(name) ? null : `imports ${spec}, not a Node built-in (node:*) or a dependency`
}

describe('Ole core isolation (#97)', () => {
  it('no file under core/ imports electron or anything outside core/', () => {
    const list = files(core)
    expect(list.length).toBeGreaterThan(10)
    const problems = list.flatMap(f => specifiers(readFileSync(f, 'utf8')).map(s => [f, s] as const))
      .flatMap(([f, s]) => { const why = refused(f, s); return why ? [`${relative(core, f)}: ${why}`] : [] })
    expect(problems).toEqual([])
  })

  it('the scan catches what it must', () => {
    const f = join(core, 'x.ts')
    expect(specifiers(`import { ipcMain } from 'electron'\nimport type { Settings } from '../../settings'\nexport { a } from './a'\nconst m = await import('../titles')\nconst r = require('electron')`))
      .toEqual(['electron', '../../settings', './a', '../titles', 'electron'])
    expect(refused(f, 'electron')).toBe('imports electron')
    expect(refused(f, '../../settings')).toMatch(/leaves core/)
    expect(refused(f, '../yogurt/session')).toMatch(/leaves core/)
    expect(refused(f, './bullets')).toBeNull()
    expect(refused(f, 'node:buffer')).toBeNull()
    expect(refused(f, 'fs')).toMatch(/not a Node built-in/)
  })
})
