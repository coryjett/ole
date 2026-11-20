// #81: a bullet that restates an earlier one in other words is dropped and counted as repeated.
import { describe, expect, it, vi } from 'vitest'
import { contentWords, createBulletsEngine, nearDuplicate, NEAR_DUPLICATE, type ChatFn } from '../../src/main/ole/core/bullets'

describe('content words (#81)', () => {
  it('lower case, stop words out, numbers and versions kept, rough stems', () => {
    expect([...contentWords('Fixed in 2.3')]).toEqual(['fix', '2.3'])
    expect([...contentWords('2.3 fixes the 429s')]).toEqual(['2.3', 'fix', '429'])
    expect([...contentWords('The rate limits are per route')]).toEqual(['rat', 'limit', 'rout'])
    expect([...contentWords('Rates limiting routes')]).toEqual(['rat', 'limit', 'rout'])
    expect([...contentWords("It's the policies' owner")]).toEqual(['policy', 'owner'])
    expect(contentWords('it is what it is').size).toBe(0)
  })
})

describe('near-duplicate bullets (#81)', () => {
  const dupes: Array<[string, string]> = [
    ['Fixed in 2.3', '2.3 fixes the 429s'],
    ['Same 429s at a fintech, fixed in 2.3', 'A fintech saw the same 429s; 2.3 fixed them'],
    ['SSO via SAML ships in Q3', 'SAML SSO is shipping in Q3'],
    ['Renewal date is 30 June', 'Their renewal is on 30 June'],
    ['Waypoint needed for L7 policies', 'L7 policies need a waypoint'],
  ]
  const distinct: Array<[string, string]> = [
    // same product, different facts
    ['Gateway 2.3 adds per-route rate limits', 'Gateway 2.4 drops Windows support'],
    ['Acme Mesh fixed the 429s in 2.3', 'Acme Mesh supports FIPS in 2.4'],
    ['Ambient mode needs no sidecars', 'Ambient mode is GA since 1.24'],
    ['Fixed in 2.3', 'Fixed in 2.4'],
    // one shared word is never enough
    ['Ztunnel handles L4', 'Ztunnel crash in 1.22 logs'],
  ]
  it.each(dupes)('drops "%s" after "%s"', (a, b) => {
    expect(nearDuplicate(b, [a])).toBe(true)
    expect(nearDuplicate(a, [b])).toBe(true)
  })
  it.each(distinct)('keeps "%s" and "%s" apart', (a, b) => {
    expect(nearDuplicate(b, [a])).toBe(false)
    expect(nearDuplicate(a, [b])).toBe(false)
  })
  it('the threshold sits between the closest distinct pair and the loosest duplicate pair', () => {
    const score = (a: string, b: string) => {
      const x = contentWords(a), y = contentWords(b)
      return [...x].filter(w => y.has(w)).length / Math.min(x.size, y.size)
    }
    const loosestDupe = Math.min(...dupes.map(([a, b]) => score(a, b)))
    const closestDistinct = Math.max(...distinct.map(([a, b]) => score(a, b)))
    expect(loosestDupe).toBeGreaterThanOrEqual(NEAR_DUPLICATE)
    expect(closestDistinct).toBeLessThan(NEAR_DUPLICATE)
  })
  // the same words around a different number or date are a different fact, however much else they share
  const conflicting: Array<[string, string]> = [
    ['Renewal date is 30 June', 'Renewal date is 30 July'],
    ['Gateway 2.3 fixes the 429 errors', 'Gateway 2.4 fixes the 429 errors'],
    ['Pilot review on Tuesday with security', 'Pilot review on Thursday with security'],
  ]
  it.each(conflicting)('keeps "%s" and "%s" apart: they differ in a number or date', (a, b) => {
    expect(nearDuplicate(b, [a])).toBe(false)
    expect(nearDuplicate(a, [b])).toBe(false)
  })
  it('compares against every earlier bullet, and an empty list never matches', () => {
    expect(nearDuplicate('2.3 fixes the 429s', ['Ambient mode needs no sidecars', 'Fixed in 2.3'])).toBe(true)
    expect(nearDuplicate('2.3 fixes the 429s', [])).toBe(false)
    expect(nearDuplicate('', ['Fixed in 2.3'])).toBe(false)
  })
})

describe('the engine drops near-duplicates (#81)', () => {
  it('against earlier turns and within a turn, counted as repeated in the log', async () => {
    let clock = 0
    const reply = (texts: string[]) => ({ content: JSON.stringify({ bullets: texts.map(text => ({ text, source: 'issue #412' })) }) })
    const chat = vi.fn<ChatFn>()
      .mockResolvedValueOnce(reply(['Fixed in 2.3']))
      .mockResolvedValueOnce(reply(['2.3 fixes the 429s', 'Gateway 2.4 drops Windows support', 'Windows support dropped in Gateway 2.4']))
    const lines: string[] = []
    const shown: string[][] = []
    const engine = createBulletsEngine({ chat, tools: () => [], callTool: async () => '', context: () => null, onBullets: all => shown.push(all.map(b => b.text)), now: () => clock, minIntervalMs: 1000, log: l => lines.push(l) })
    engine.push({ speaker: 'Them', text: 'we keep seeing errors', startMs: 0 })
    await vi.waitFor(() => expect(lines).toHaveLength(1))
    clock = 2000
    engine.push({ speaker: 'Them', text: 'and the old platform', startMs: 2000 })
    await vi.waitFor(() => expect(lines).toHaveLength(2))
    engine.stop()
    expect(shown.at(-1)).toEqual(['Gateway 2.4 drops Windows support', 'Fixed in 2.3'])
    expect(lines[1]).toMatch(/^ole bullets: 3 back, 1 shown, 0 without a source, 2 repeated, 0 lookups/)
  })
})
