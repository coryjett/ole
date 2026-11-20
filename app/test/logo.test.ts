import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MARK, WORD } from '../src/shared/logo'

const svg = (name: string) => readFileSync(join(import.meta.dirname, '../build', name), 'utf8')
const paths = (text: string) => [...text.matchAll(/ d="([^"]+)"/g)].map((m) => m[1])

// Ole: the app draws the mark from shared/logo.ts and the icons come from build/*.svg; they stay one drawing.
// Yogurt's mark and name are Frigade's, so none of Ole's art may carry them.
describe('logo', () => {
  it('is the Ole ring, not the Yogurt mark', () => {
    expect(MARK.startsWith('M50 8a42 42')).toBe(true)
    expect(WORD).toBeTypeOf('string')
  })
  it('matches build/logo.svg and build/wordmark.svg', () => {
    expect(paths(svg('logo.svg'))).toEqual([MARK])
    expect(paths(svg('wordmark.svg'))).toEqual([MARK])
    expect(svg('wordmark.svg')).toContain('>¡ole!</text>')
  })
  it('no build art names Yogurt', () => {
    for (const name of ['icon.svg', 'logo.svg', 'wordmark.svg']) expect(svg(name).toLowerCase()).not.toContain('yogurt')
  })
})
