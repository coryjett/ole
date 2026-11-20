import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { liveToolsFor, parseTurnLog, redactReason, replayCall, replaySettings, summarise, virtualClock, type ReplayFixture } from '../../src/main/ole/replay'
import type { ChatFn } from '../../src/main/ole/bullets'

const dir = join(__dirname, 'fixtures', 'replay')
const fixture = (name: string): ReplayFixture => JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8'))

describe('replaying saved calls (#66)', () => {
  it('a steady call: drops, repeats, unverified excerpts, an invented link and a wordy headline are all counted', async () => {
    const r = await replayCall(fixture('steady-call'))
    expect(summarise(r)).toBe([
      'steady-call: 6:05 call, 25 lines',
      '  turns 9 (0 failed, 0 unrecorded); lookups 0 asked, 0 made, 0 refused',
      '  bullets 6 back, 4 shown, 1 without a source, 1 repeated',
      '  excerpts: heard 2/3 verified, quote 2/3 verified, links 1/2 kept',
      '  headlines: 6 to 13 words (median 7), longest 89 chars, 1 over ten words, 1 cut',
      '  quiet: longest 1:35 with nothing new (4:30 to 6:05); first bullet at 0:45',
    ].join('\n'))
    // the engine runs at most every 45 s of conversation
    expect(r.timeline.map(t => t.atMs)).toEqual([0, 45_000, 90_000, 135_000, 180_000, 225_000, 270_000, 315_000, 360_000])
    expect(r.timeline[3]).toEqual({ atMs: 135_000, back: 1, shown: 0, withoutSource: 0, repeated: 1, lookups: 0 })
    expect(r.shown.map(s => [s.atMs, s.text, s.heard, s.quote, s.url])).toEqual([
      [45_000, 'Platform expansion is 180k, closes 15 Dec', false, true, false],
      [90_000, 'Burst 429s fixed in Beacon 2.3', true, true, true],
      [180_000, 'They run an open source proxy today', true, false, false],
      [270_000, 'Consider relating the latency discussion to the earlier benchmark results from the pilot…', false, false, false],
    ])
  })

  it('a call with lookups: latency, a failed turn, a refused repeat lookup and a tool name as source', async () => {
    const r = await replayCall(fixture('lookup-call'))
    expect(summarise(r)).toBe([
      'lookup-call: 5:05 call, 16 lines',
      '  turns 7 (1 failed, 0 unrecorded); lookups 3 asked, 2 made, 1 refused',
      '  bullets 3 back, 2 shown, 1 without a source, 0 repeated',
      '  excerpts: heard 2/2 verified, quote 2/2 verified, links 1/1 kept',
      '  headlines: 8 to 9 words (median 8.5), longest 63 chars, 0 over ten words, 0 cut',
      '  quiet: longest 2:42 with nothing new (2:23 to 5:05); first bullet at 0:53',
    ].join('\n'))
    expect(r.timeline[2]).toEqual({ atMs: 90_000, back: 0, shown: 0, withoutSource: 0, repeated: 0, lookups: 0, failed: '429 rate limited' })
    // two model replies of 4 s each: the bullet lands 8 s after its turn started
    expect(r.shown.map(s => s.atMs)).toEqual([53_000, 143_000])
    expect(r.lookups).toEqual({ asked: 3, made: 2, refused: 1, unrecorded: 0 })
  })

  it('a quiet call with no account: more turns than recorded answer empty and the long silence shows', async () => {
    const r = await replayCall(fixture('quiet-call'))
    expect(summarise(r)).toBe([
      'quiet-call: 10:05 call, 21 lines',
      '  turns 14 (0 failed, 10 unrecorded); lookups 0 asked, 0 made, 0 refused',
      '  bullets 1 back, 1 shown, 0 without a source, 0 repeated',
      '  excerpts: heard 1/1 verified, quote 1/1 verified, links 0/0 kept',
      '  headlines: 7 to 7 words (median 7), longest 46 chars, 0 over ten words, 0 cut',
      '  quiet: longest 8:35 with nothing new (1:30 to 10:05); first bullet at 1:30',
    ].join('\n'))
  })

  it('a replay is deterministic', async () => {
    for (const name of ['steady-call', 'lookup-call', 'quiet-call']) expect(await replayCall(fixture(name))).toEqual(await replayCall(fixture(name)))
  })

  it('a live model replaces the recorded replies; lookups still answer from the fixture', async () => {
    const chat = vi.fn<ChatFn>(async req => {
      if (req.messages.at(-1)?.role === 'tool') return { content: JSON.stringify({ bullets: [{ text: 'Certs rotate daily', source: 'product docs: Certificate rotation', quote: 'rotates mTLS certificates every 24 hours' }] }) }
      if (req.messages.some(m => m.role === 'assistant')) return { content: '{"bullets":[]}' }
      return { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'docs__search_docs', arguments: '{"query":"mutual TLS certificate rotation"}' } }] }
    })
    const r = await replayCall(fixture('lookup-call'), { chat })
    expect(chat).toHaveBeenCalled()
    expect(r.shown).toEqual([{ atMs: 0, text: 'Certs rotate daily', source: 'product docs: Certificate rotation', words: 3, heard: false, quote: true, url: false }])
    expect(r.turns.unrecorded).toBe(0)
    // the same lookup on later turns is refused by the engine, never sent
    expect(r.lookups.made).toBe(1)
  })

  it('a call stopped mid-turn does not count that turn', async () => {
    const f: ReplayFixture = { name: 'cut', briefing: { text: '' }, transcript: [{ speaker: 'A', text: 'hello', startMs: 0 }], endMs: 1_000, latencyMs: 5_000, turns: [{ replies: [{ bullets: [] }] }] }
    const r = await replayCall(f)
    expect(r.turns.total).toBe(0)
    expect(r.quiet).toEqual({ longestMs: 1_000, fromMs: 0, toMs: 1_000, firstBulletMs: null })
    expect(summarise(r)).toContain('headlines: none shown')
  })
})

describe('replay matches the app (security review)', () => {
  const offeredNames = async (f: ReplayFixture) => {
    const seen: string[][] = []
    await replayCall(f, { chat: async req => { seen.push(((req.tools ?? []) as Array<{ function: { name: string } }>).map(t => t.function.name)); return { content: '{"bullets":[]}' } } })
    return seen[0]
  }

  it('a call without an account is offered no customer-record tools and no write tools (#57)', async () => {
    expect(await offeredNames(fixture('quiet-call'))).toEqual(['docs__search_docs'])
  })

  it('a call with an account gets the lookup-style tools only, as session.ts does', async () => {
    const f = { ...fixture('quiet-call'), briefing: fixture('steady-call').briefing }
    expect(await offeredNames(f)).toEqual(['crm__get_account_details', 'crm__list_opportunities', 'docs__search_docs'])
    expect(liveToolsFor([], null)).toEqual([])
  })

  it('a fixture sets only the three engine settings, clamped; anything else is ignored', async () => {
    expect(replaySettings({ minIntervalMs: 1, windowMs: 1e12, maxLookupsPerMinute: 99, chat: () => {}, now: () => 0, log: 'x' })).toEqual({ minIntervalMs: 1_000, windowMs: 1_800_000, maxLookupsPerMinute: 20 })
    expect(replaySettings({ minIntervalMs: Number.NaN, windowMs: '5', maxLookupsPerMinute: -3 })).toEqual({ maxLookupsPerMinute: 0 })
    expect(replaySettings(undefined)).toEqual({})
    expect(replaySettings([1, 2])).toEqual({})
    // a chat smuggled into settings never replaces the recorded replies
    const f = { ...fixture('steady-call'), settings: { chat: 'not a function' } } as unknown as ReplayFixture
    expect(summarise(await replayCall(f))).toBe(summarise(await replayCall(fixture('steady-call'))))
  })

  it('a failure reason in the report is short, with no URLs or keys', async () => {
    expect(redactReason('OpenAI request failed (401): bad key sk-proj-abcdEFGH1234567890 at https://llm.example.com/v1/chat?k=1')).toBe('OpenAI request failed (401): bad key [key] at [url]')
    expect(redactReason('Authorization: Bearer abc.def.ghi')).toBe('Authorization: Bearer [key]')
    expect(redactReason('token 0123456789abcdef0123456789abcdef0123 leaked')).toBe('token [key] leaked')
    expect(redactReason('word '.repeat(60))).toHaveLength(120)
    const f: ReplayFixture = { name: 'fail', briefing: { text: '' }, transcript: [{ speaker: 'A', text: 'hello', startMs: 0 }], turns: [{ replies: [{ error: 'denied for sk-live-0123456789abcdef by https://api.example.com/v1' }] }] }
    expect((await replayCall(f)).timeline[0].failed).toBe('denied for [key] by [url]')
  })
})

describe('replay pieces', () => {
  it('parses the engine log line, and only that', () => {
    expect(parseTurnLog('ole bullets: 3 back, 1 shown, 1 without a source, 1 repeated, 2 lookups')).toEqual({ back: 3, shown: 1, withoutSource: 1, repeated: 1, lookups: 2 })
    expect(parseTurnLog('ole bullets: turn failed: boom')).toMatchObject({ failed: 'boom' })
    expect(parseTurnLog('something else')).toBeNull()
  })

  it('the virtual clock runs due timers in time order and skips cleared ones', async () => {
    const c = virtualClock()
    const seen: Array<[string, number]> = []
    c.timers.set(() => seen.push(['b', c.now()]), 200)
    const gone = c.timers.set(() => seen.push(['x', c.now()]), 100)
    c.timers.set(() => { seen.push(['a', c.now()]); c.timers.set(() => seen.push(['c', c.now()]), 50) }, 100)
    c.timers.clear(gone)
    await c.advanceTo(160, async () => {})
    expect(seen).toEqual([['a', 100], ['c', 150]])
    expect(c.now()).toBe(160)
    await c.advanceTo(1_000, async () => {})
    expect(seen.at(-1)).toEqual(['b', 200])
    expect(c.pending()).toBe(0)
  })

  it('the harness is dev only: nothing in the app imports it', () => {
    const src = join(__dirname, '..', '..', 'src')
    const files = readdirSync(src, { recursive: true }).map(String).filter(f => /\.tsx?$/.test(f) && !f.endsWith('replay.ts'))
    const importers = files.filter(f => /from ['"][^'"]*\/replay['"]|from ['"]\.\/replay['"]/.test(readFileSync(join(src, f), 'utf8')))
    expect(importers).toEqual([])
  })

  it('fixtures are synthetic: example.com links only', () => {
    for (const f of readdirSync(dir)) {
      const urls = readFileSync(join(dir, f), 'utf8').match(/https?:\/\/[^\s"]+/g) ?? []
      expect(urls.every(u => new URL(u).hostname.endsWith('example.com'))).toBe(true)
    }
  })
})
