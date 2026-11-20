// #84: a bullets turn streams its answer and shows each bullet as soon as it is complete and has passed the checks.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createBulletStream } from '../../src/main/ole/core/bulletStream'
import { createBulletsEngine, type ChatFn, type ChatMessage } from '../../src/main/ole/core/bullets'
import { openaiChat } from '../../src/main/ole/core/openai'
import { replayCall, type ReplayFixture } from '../../src/main/ole/core/replay'
import type { OleBullet } from '../../src/main/ole/core/types'

const collect = (pieces: string[]) => {
  const items: unknown[] = []
  const s = createBulletStream(i => items.push(i))
  for (const p of pieces) s.push(p)
  return { items, s }
}
const chars = (t: string) => [...t]

describe('the incremental bullets parser (#84)', () => {
  const doc = '```json\n{"note":"a \\"bullets\\" {[ word","bullets":[{"text":"Fixed in \\"2.3\\" {}","source":"issue #4","meta":{"tags":["a","}"]}},{"text":"Second","source":"call notes"}],"after":[{"x":1}]}\n```'

  it('yields each element whole, at any split point: inside strings, after escapes, in nested objects', () => {
    const want = JSON.parse(doc.slice(8, -4)).bullets
    for (let cut = 1; cut < doc.length; cut++) expect(collect([doc.slice(0, cut), doc.slice(cut)]).items).toEqual(want)
    expect(collect(chars(doc)).items).toEqual(want)
  })

  it('hands over the first element as soon as its closing brace arrives', () => {
    const items: unknown[] = []
    const s = createBulletStream(i => items.push(i))
    const first = '{"bullets":[{"text":"One","source":"a"}'
    s.push(first.slice(0, -1))
    expect(items).toHaveLength(0)
    s.push('}')
    expect(items).toEqual([{ text: 'One', source: 'a' }])
    expect(s.count()).toBe(1)
    s.push(',{"text":"Tw')
    expect(items).toHaveLength(1)
  })

  it('ignores arrays that are not the top-level "bullets", and anything after the object closes', () => {
    expect(collect(['{"x":{"bullets":[{"text":"no","source":"s"}]},"bullets":[]}', '{"bullets":[{"text":"late","source":"s"}]}']).items).toEqual([])
    expect(collect(['not json at all']).items).toEqual([])
    expect(collect(['{"bullets":[{"text":"broken",]}']).items).toEqual([])
  })
})

const sse = (events: unknown[], o: { done?: boolean; breakAfter?: number } = {}) => {
  const enc = new TextEncoder()
  const text = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + (o.done === false ? '' : 'data: [DONE]\n\n')
  return new Response(new ReadableStream({
    start(c) {
      const cut = o.breakAfter ?? text.length
      for (let i = 0; i < Math.min(cut, text.length); i += 5) c.enqueue(enc.encode(text.slice(i, Math.min(i + 5, cut))))
      if (o.breakAfter !== undefined) c.error(new Error('socket hang up'))
      else c.close()
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const delta = (content: string) => ({ choices: [{ delta: { content } }] })
const ANSWER = '{"bullets":[{"text":"Fixed in 2.3","source":"issue #4"}]}'
const req = (onDelta?: (t: string) => void) => ({ key: 'sk-test', model: 'm', messages: [{ role: 'user' as const, content: 'hi' }], onDelta })

describe('openaiChat streaming (#84)', () => {
  it('asks with stream: true, hands each piece to onDelta and resolves with the whole message', async () => {
    const fetch = vi.fn(async () => sse([delta('{"bullets":'), delta('[]}'), { choices: [{ delta: {}, finish_reason: 'stop' }] }]))
    const pieces: string[] = []
    const m = await openaiChat({ ...req(t => pieces.push(t)), fetch: fetch as never })
    expect(m).toEqual({ role: 'assistant', content: '{"bullets":[]}' })
    expect(pieces).toEqual(['{"bullets":', '[]}'])
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown[])[1] && ((fetch.mock.calls[0] as unknown[])[1] as RequestInit).body)).stream).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('puts streamed tool calls back together, and stops passing content on once a call starts', async () => {
    const fetch = vi.fn(async () => sse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 's__search', arguments: '{"q":' } }] } }] },
      { choices: [{ delta: { content: 'x', tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]))
    const pieces: string[] = []
    const m = await openaiChat({ ...req(t => pieces.push(t)), fetch: fetch as never })
    expect(m.tool_calls).toEqual([{ id: 'c1', type: 'function', function: { name: 's__search', arguments: '{"q":"a"}' } }])
    expect(pieces).toEqual([])
  })

  it('a server that ignores stream and answers whole still works', async () => {
    const fetch = vi.fn(async () => json({ choices: [{ message: { role: 'assistant', content: ANSWER } }] }))
    const pieces: string[] = []
    expect((await openaiChat({ ...req(t => pieces.push(t)), fetch: fetch as never })).content).toBe(ANSWER)
    expect(pieces).toEqual([])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('a stream that breaks, or ends without saying it is done, is asked again without streaming', async () => {
    for (const broken of [sse([delta('{"bul')], { breakAfter: 40 }), sse([delta('{"bul')], { done: false })]) {
      const fetch = vi.fn().mockResolvedValueOnce(broken).mockResolvedValueOnce(json({ choices: [{ message: { role: 'assistant', content: ANSWER } }] }))
      const m = await openaiChat({ ...req(() => {}), fetch: fetch as never })
      expect(m.content).toBe(ANSWER)
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(JSON.parse(String((fetch.mock.calls[1][1] as RequestInit).body)).stream).toBe(false)
    }
  })

  it('a server that refuses stream with a 400 is asked again without it; other errors fail as before', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ error: { message: 'stream is not supported' } }, 400)).mockResolvedValueOnce(json({ choices: [{ message: { role: 'assistant', content: ANSWER } }] }))
    expect((await openaiChat({ ...req(() => {}), fetch: fetch as never })).content).toBe(ANSWER)
    const down = vi.fn(async () => json({ error: { message: 'overloaded' } }, 503))
    await expect(openaiChat({ ...req(() => {}), fetch: down as never })).rejects.toThrow('(503)')
    expect(down).toHaveBeenCalledTimes(1)
  })

  it('without onDelta nothing changes: one non-streamed request', async () => {
    const fetch = vi.fn(async () => json({ choices: [{ message: { role: 'assistant', content: ANSWER } }] }))
    await openaiChat({ ...req(), fetch: fetch as never })
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body)).stream).toBe(false)
  })
})

const ctx = { meetingTitle: 'Sync', focus: null, text: '## Before you join\n- Beacon 2.3 fixed burst 429s (issue #4)', preparedAt: 1 }
const TWO = '{"bullets":[{"text":"Burst 429s fixed in Beacon 2.3","source":"issue #4","quote":"Beacon 2.3 fixed burst 429s"},{"text":"Renewal closes 15 Dec","source":"opportunity: Renewal"}]}'

/** a chat that streams its answer in pieces and waits for the test before finishing */
function gatedStream(content: string, split: number) {
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  const chat = vi.fn<ChatFn>(async (r) => {
    r.onDelta?.(content.slice(0, split))
    await gate
    r.onDelta?.(content.slice(split))
    return { content }
  })
  return { chat, release }
}

describe('the engine shows bullets as they stream (#84)', () => {
  it('the first bullet reaches the panel before the answer ends; the turn is logged as before', async () => {
    const split = TWO.indexOf(',{"text":"Renewal')
    const { chat, release } = gatedStream(TWO, split)
    const shown: OleBullet[][] = [], logs: string[] = []
    const engine = createBulletsEngine({ chat, tools: () => [], callTool: async () => '', context: () => ctx, onBullets: all => shown.push(all), now: () => 0, log: l => logs.push(l) })
    engine.push({ speaker: 'Them', text: 'what about the 429s', startMs: 0 })
    await vi.waitFor(() => expect(shown).toHaveLength(1))
    expect(shown[0].map(b => b.text)).toEqual(['Burst 429s fixed in Beacon 2.3'])
    expect(shown[0][0].quote).toBe('Beacon 2.3 fixed burst 429s')
    expect(logs).toEqual([])
    release()
    await vi.waitFor(() => expect(logs).toHaveLength(1))
    engine.stop()
    // the second arrives later, below the first: the same order as a whole reply
    expect(shown.at(-1)!.map(b => b.text)).toEqual(['Burst 429s fixed in Beacon 2.3', 'Renewal closes 15 Dec'])
    expect(logs[0]).toBe('ole bullets: 2 back, 2 shown, 0 without a source, 0 repeated, 0 lookups')
  })

  it('streamed or whole, the same bullets and the same log line; a duplicate within the turn is caught as it streams', async () => {
    const reply = '{"bullets":[{"text":"Burst 429s fixed in Beacon 2.3","source":"issue #4"},{"text":"Beacon 2.3 fixes the burst 429s","source":"issue #4"},{"text":"No source here","source":"Before you join"}]}'
    const run = async (stream: boolean) => {
      const chat: ChatFn = async (r) => { if (stream) for (const c of reply.match(/.{1,7}/gs)!) r.onDelta?.(c); return { content: reply } }
      const logs: string[] = []
      let last: OleBullet[] = []
      const engine = createBulletsEngine({ chat, tools: () => [], callTool: async () => '', context: () => ctx, onBullets: all => { last = all }, now: () => 0, log: l => logs.push(l) })
      engine.push({ speaker: 'Them', text: 'what about the 429s', startMs: 0 })
      await vi.waitFor(() => expect(logs).toHaveLength(1))
      engine.stop()
      return { logs, texts: last.map(b => [b.id, b.text]) }
    }
    const streamed = await run(true), whole = await run(false)
    expect(streamed).toEqual(whole)
    expect(whole.logs[0]).toBe('ole bullets: 3 back, 1 shown, 1 without a source, 1 repeated, 0 lookups')
  })

  it('falls back to the whole reply: a stream that never parses shows only what the whole reply holds, once', async () => {
    // a broken stream re-asked without streaming: the pieces said one thing, the whole answer holds both bullets
    const chat: ChatFn = async (r) => { r.onDelta?.(TWO.slice(0, TWO.indexOf(',{"text":"Renewal'))); return { content: TWO } }
    const logs: string[] = [], calls: number[] = []
    let last: OleBullet[] = []
    const engine = createBulletsEngine({ chat, tools: () => [], callTool: async () => '', context: () => ctx, onBullets: all => { last = all; calls.push(all.length) }, now: () => 0, log: l => logs.push(l) })
    engine.push({ speaker: 'Them', text: 'what about the 429s', startMs: 0 })
    await vi.waitFor(() => expect(logs).toHaveLength(1))
    engine.stop()
    expect(last.map(b => b.text)).toEqual(['Burst 429s fixed in Beacon 2.3', 'Renewal closes 15 Dec'])
    expect(calls).toEqual([1, 2])
    expect(logs[0]).toBe('ole bullets: 2 back, 2 shown, 0 without a source, 0 repeated, 0 lookups')
    // a chat that ignores onDelta entirely is the old path: one update with both
    const plain: ChatFn = async () => ({ content: TWO })
    const seen: number[] = []
    const e2 = createBulletsEngine({ chat: plain, tools: () => [], callTool: async () => '', context: () => ctx, onBullets: all => seen.push(all.length), now: () => 0, log: () => {} })
    e2.push({ speaker: 'Them', text: 'what about the 429s', startMs: 0 })
    await vi.waitFor(() => expect(seen).toEqual([2]))
    e2.stop()
  })

  it('lookup rounds are unchanged: only the answer after them shows bullets, and its excerpts are checked against the results', async () => {
    const tool = { name: 's__search_docs', serverId: 's', serverName: 'S', tool: 'search_docs', description: '', parameters: { type: 'object' } }
    const answer = '{"bullets":[{"text":"Retry budget defaults to 20%","source":"docs: retries","quote":"the retry budget defaults to 20 percent","url":"https://example.com/retries"}]}'
    const chat = vi.fn<ChatFn>()
      .mockImplementationOnce(async () => ({ content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 's__search_docs', arguments: '{"q":"retry budget"}' } }] }))
      .mockImplementationOnce(async (r) => { r.onDelta?.(answer); return { content: answer } })
    let last: OleBullet[] = []
    const logs: string[] = []
    const engine = createBulletsEngine({ chat, tools: () => [tool], callTool: async () => 'Retries: the retry budget defaults to 20 percent. https://example.com/retries', context: () => ctx, onBullets: all => { last = all }, now: () => 0, log: l => logs.push(l) })
    engine.push({ speaker: 'Them', text: 'what is the retry budget', startMs: 0 })
    await vi.waitFor(() => expect(logs).toHaveLength(1))
    engine.stop()
    expect(chat.mock.calls.every(c => typeof c[0].onDelta === 'function')).toBe(true)
    expect(last[0]).toMatchObject({ text: 'Retry budget defaults to 20%', quote: 'the retry budget defaults to 20 percent', url: 'https://example.com/retries' })
    expect(logs[0]).toBe('ole bullets: 1 back, 1 shown, 0 without a source, 0 repeated, 1 lookups')
  })

  it('a call stopped mid-stream shows nothing more', async () => {
    const split = TWO.indexOf(',{"text":"Renewal')
    const { chat, release } = gatedStream(TWO, split)
    const shown: OleBullet[][] = []
    const engine = createBulletsEngine({ chat, tools: () => [], callTool: async () => '', context: () => ctx, onBullets: all => shown.push(all), now: () => 0, log: () => {} })
    engine.push({ speaker: 'Them', text: 'what about the 429s', startMs: 0 })
    await vi.waitFor(() => expect(shown).toHaveLength(1))
    engine.stop()
    release()
    await new Promise(r => setTimeout(r, 10))
    expect(shown).toHaveLength(1)
  })
})

describe('replay with streamed replies (#84)', () => {
  const dir = join(__dirname, 'fixtures', 'replay')
  /** answers from the fixture's recorded replies, whole (ignoring onDelta) or streamed in small pieces */
  const scripted = (f: ReplayFixture, stream: boolean): ChatFn => {
    let turn = -1
    return async (r) => {
      if (r.messages.at(-1)?.role === 'user') turn++
      const step = r.messages.filter((m: ChatMessage) => m.role === 'assistant').length
      const rec = f.turns[turn]?.replies[step]
      if (!rec) return { content: '{"bullets":[]}' }
      if (rec.error !== undefined) throw new Error(rec.error)
      if (rec.toolCalls?.length) return { content: null, tool_calls: rec.toolCalls.map((c, i) => ({ id: `c${turn}_${step}_${i}`, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) } })) }
      const content = rec.bullets ? JSON.stringify({ bullets: rec.bullets }) : rec.content ?? '{"bullets":[]}'
      if (stream && content) for (const c of content.match(/.{1,5}/gs) ?? []) r.onDelta?.(c)
      return { content }
    }
  }

  it.each(['steady-call', 'lookup-call', 'quiet-call'])('%s: a streamed reply gives the same report as a whole one', async (name) => {
    const raw: ReplayFixture = JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8'))
    const f = { ...raw, settings: { ...raw.settings, fastMinMs: 0 } }
    const whole = await replayCall(f, { chat: scripted(f, false) })
    const streamed = await replayCall(f, { chat: scripted(f, true) })
    expect(streamed).toEqual(whole)
    expect(whole.bullets.shown).toBeGreaterThan(0)
  })
})
