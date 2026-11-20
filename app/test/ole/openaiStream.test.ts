import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOpenAIStreaming, pcm16Base64, REALTIME_URL, STREAM_MODEL, Upsampler, type WsLike } from '../../src/main/ole/openaiStream'
import { chunker, type Chunk } from '../../src/main/asr/chunker'
import type { Transcribe } from '../../src/main/asr/transcribe'
import type { Track } from '../../src/main/capture'

const RATE = 16000
const tone = (sec: number) => Float32Array.from({ length: Math.round(sec * RATE) }, (_, i) => 0.3 * Math.sin(i / 10))
const quiet = (sec: number) => new Float32Array(Math.round(sec * RATE))

type Ev = Record<string, unknown> & { type: string }

/** a stand-in Realtime socket: what the client sent, and the server's side to drive */
class FakeWs implements WsLike {
  readyState = 0
  sent: Ev[] = []
  closed = false
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onclose: ((ev: { code?: number }) => void) | null = null
  constructor(public url: string, public headers: Record<string, string>) {}
  send(d: string) { this.sent.push(JSON.parse(d)) }
  close() { this.closed = true; this.readyState = 3 }
  open() { this.readyState = 1; this.onopen?.({}) }
  server(e: Ev) { this.onmessage?.({ data: JSON.stringify(e) }) }
  ready() { this.open(); this.server({ type: 'session.updated', session: {} }) }
  drop() { this.readyState = 3; this.onclose?.({ code: 1006 }) }
  fail() { this.onerror?.({}); this.onclose?.({ code: 1006 }) }
  of(type: string) { return this.sent.filter((e) => e.type === type) }
  /** the server answers each commit not answered yet with a final, in order */
  answer(...texts: string[]) {
    for (const text of texts) {
      const n = this.items++
      this.server({ type: 'input_audio_buffer.committed', item_id: `item_${n}`, previous_item_id: null })
      this.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: `item_${n}`, content_index: 0, transcript: text })
    }
  }
  items = 0
}

/** the chunked transcriber's stand-in: says which chunk it was asked for */
const chunkedFor = () => vi.fn<Transcribe>(async (c: Chunk, o?: { partial?: boolean }) => o?.partial ? [] : [{ track: c.track, startMs: c.startMs, endMs: c.startMs + 1, text: `chunked ${c.startMs}` }])

function rig(o: { key?: () => string | null; finalTimeoutMs?: number; now?: () => number } = {}) {
  const sockets: FakeWs[] = []
  const logs: string[] = []
  const fallback = chunkedFor()
  const s = createOpenAIStreaming({
    key: o.key ?? (() => 'sk-test-key'), fallback, ws: (url, headers) => { const w = new FakeWs(url, headers); sockets.push(w); return w },
    log: (l) => logs.push(l), finalTimeoutMs: o.finalTimeoutMs ?? 300, lookupMs: 50, now: o.now,
  })
  // the pipeline's own chunker, seeing the same audio: the chunks it would ask for
  const chunks: Chunk[] = []
  const ref = chunker((c) => chunks.push(c))
  /** audio in 100 ms frames from meeting time ms, to the stream first (as asr/index.ts does), then the pipeline's chunker */
  const feed = (track: Track, ms: number, audio: Float32Array) => {
    for (let i = 0; i < audio.length; i += 1600) {
      const f = audio.subarray(i, i + 1600)
      s.push(track, ms + i / 16, f)
      ref.push(track, ms + i / 16, f)
    }
  }
  /** someone talks for sec seconds from ms, then a pause long enough to end the chunk */
  const say = (track: Track, ms: number, sec = 1) => { const before = chunks.length; feed(track, ms, Float32Array.from([...tone(sec), ...quiet(1.5)])); return chunks.slice(before) }
  return { s, sockets, logs, fallback, chunks, feed, say }
}

const appendedSamples = (w: FakeWs) => w.of('input_audio_buffer.append').reduce((n, e) => n + Buffer.from(String(e.audio), 'base64').length / 2, 0)

let spies: Array<ReturnType<typeof vi.spyOn>> = []
afterEach(() => { spies.forEach((s) => s.mockRestore()); spies = [] })

describe('streaming transcription (#85)', () => {
  it('opens a transcription session with the key per connection, and sends no audio before the session is ready', () => {
    const r = rig()
    r.feed('me', 0, tone(0.5))
    expect(r.sockets).toHaveLength(1)
    const w = r.sockets[0]
    expect(w.url).toBe(REALTIME_URL)
    expect(w.url).toBe('wss://api.openai.com/v1/realtime?intent=transcription')
    expect(w.headers).toEqual({ Authorization: 'Bearer sk-test-key' })
    expect(w.sent).toEqual([])
    w.open()
    expect(w.sent).toEqual([{ type: 'session.update', session: { type: 'transcription', audio: { input: { format: { type: 'audio/pcm', rate: 24000 }, transcription: { model: STREAM_MODEL }, turn_detection: null } } } }])
    expect(STREAM_MODEL).toBe('gpt-live-transcribe')
    w.server({ type: 'session.updated', session: {} })
    // the queued speech goes out once the session is ready, then each frame as it comes
    const before = w.of('input_audio_buffer.append').length
    expect(before).toBeGreaterThan(0)
    r.feed('me', 500, tone(0.2))
    expect(w.of('input_audio_buffer.append').length).toBeGreaterThan(before)
  })

  it('one connection per track', () => {
    const r = rig()
    r.feed('me', 0, tone(0.5))
    r.feed('them', 0, tone(0.5))
    expect(r.sockets).toHaveLength(2)
  })

  it('streams the speech as 24 kHz PCM16 and commits when the chunk ends; silence between turns is not sent', () => {
    const r = rig()
    r.feed('me', 0, quiet(3))
    expect(r.sockets).toHaveLength(0)
    const chunks = r.say('me', 3000, 1)
    expect(chunks).toHaveLength(1)
    const w = r.sockets[0]
    w.ready()
    expect(w.of('input_audio_buffer.commit')).toHaveLength(1)
    // the turn: up to 0.3 s before the speech, the speech, and the pause up to the cut (no more than 1.5 s of it)
    const sent = appendedSamples(w) / 24000
    expect(sent).toBeGreaterThan(1.9)
    expect(sent).toBeLessThan(1 + 0.3 + 1.5 + 0.2)
    // the commit came after the turn's audio
    expect(w.sent.at(-1)).toEqual({ type: 'input_audio_buffer.commit' })
    r.feed('me', 5500, quiet(5))
    expect(appendedSamples(w) / 24000).toBe(sent)
  })

  it('the final is the streamed transcript, one line timed by the chunk on the meeting clock', async () => {
    const r = rig()
    const [c] = r.say('them', 5000, 1.2)
    const w = r.sockets[0]
    w.ready()
    const p = r.s.transcribe(c)
    w.answer('  Hello,   how are you? ')
    const lines = await p
    expect(lines).toEqual([{ track: 'them', startMs: c.startMs, endMs: c.startMs + Math.round(c.samples.length / 16), text: 'Hello, how are you?' }])
    expect(c.startMs).toBeGreaterThanOrEqual(5000)
    expect(r.fallback).not.toHaveBeenCalled()
  })

  it('a final already in when the chunk is asked for is given at once; an empty one gives no line', async () => {
    const r = rig()
    const [a] = r.say('me', 0, 1)
    const w = r.sockets[0]
    w.ready()
    w.answer('first')
    const [b] = r.say('me', 4000, 1)
    w.answer('   ')
    expect(await r.s.transcribe(a)).toEqual([expect.objectContaining({ text: 'first', startMs: a.startMs })])
    expect(await r.s.transcribe(b)).toEqual([])
    expect(r.fallback).not.toHaveBeenCalled()
  })

  it('finals that come back out of order go to the right chunk by item id', async () => {
    const r = rig()
    const [a] = r.say('me', 0, 1)
    const [b] = r.say('me', 4000, 1)
    const w = r.sockets[0]
    w.ready()
    w.server({ type: 'input_audio_buffer.committed', item_id: 'A', previous_item_id: null })
    w.server({ type: 'input_audio_buffer.committed', item_id: 'B', previous_item_id: 'A' })
    w.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'B', content_index: 0, transcript: 'second' })
    w.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'A', content_index: 0, transcript: 'first' })
    expect((await r.s.transcribe(a))[0].text).toBe('first')
    expect((await r.s.transcribe(b))[0].text).toBe('second')
  })

  it('a quick reading returns the deltas heard so far for the open chunk', async () => {
    const r = rig()
    const partials: Chunk[] = [], finals: Chunk[] = []
    const ref = chunker((c) => finals.push(c), (c) => partials.push(c))
    const feed = (ms: number, audio: Float32Array) => { for (let i = 0; i < audio.length; i += 1600) { r.s.push('them', ms + i / 16, audio.subarray(i, i + 1600)); ref.push('them', ms + i / 16, audio.subarray(i, i + 1600)) } }
    feed(0, tone(2))
    const w = r.sockets[0]
    w.ready()
    w.server({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'live1', content_index: 0, delta: 'Hello,' })
    w.server({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'live1', content_index: 0, delta: ' how' })
    const c = partials.at(-1)!
    expect(await r.s.transcribe(c, { partial: true })).toEqual([{ track: 'them', startMs: c.startMs, endMs: c.startMs + Math.round(c.samples.length / 16), text: 'Hello, how' }])
    // the commit then names the same item, and its final replaces the reading
    feed(2000, quiet(1.5))
    const final = finals.at(-1)!
    w.server({ type: 'input_audio_buffer.committed', item_id: 'live1', previous_item_id: null })
    w.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'live1', content_index: 0, transcript: 'Hello, how are you?' })
    expect((await r.s.transcribe(final))[0].text).toBe('Hello, how are you?')
    expect(await r.s.transcribe(c, { partial: true })).toEqual([])
  })

  it('a dropped connection sends its unfinished turn the chunked way, and the next turn reconnects after a backoff', async () => {
    let t = 0
    const r = rig({ now: () => t })
    const [a] = r.say('me', 0, 1)
    r.sockets[0].ready()
    r.sockets[0].drop()
    expect(await r.s.transcribe(a)).toEqual([{ track: 'me', startMs: a.startMs, endMs: a.startMs + 1, text: `chunked ${a.startMs}` }])
    // within the backoff: the turn goes chunked, no new connection
    t = 500
    const [b] = r.say('me', 4000, 1)
    expect(r.sockets).toHaveLength(1)
    expect((await r.s.transcribe(b))[0].text).toBe(`chunked ${b.startMs}`)
    // after it: a new connection, streamed again
    t = 1500
    const [c] = r.say('me', 8000, 1)
    expect(r.sockets).toHaveLength(2)
    r.sockets[1].ready()
    r.sockets[1].answer('back again')
    expect((await r.s.transcribe(c))[0].text).toBe('back again')
    expect(r.s.fellBack()).toBeNull()
    expect(r.logs).toEqual([])
  })

  it('a refused key falls back to chunks for the rest of the recording, logged once', async () => {
    const r = rig()
    const [a] = r.say('me', 0, 1)
    const w = r.sockets[0]
    w.open()
    w.server({ type: 'error', event_id: 'e1', error: { type: 'invalid_request_error', code: 'invalid_api_key', message: 'Incorrect API key provided: sk-test-key', param: null } })
    expect(r.s.fellBack()).toBe('auth')
    expect(w.closed).toBe(true)
    expect((await r.s.transcribe(a))[0].text).toBe(`chunked ${a.startMs}`)
    const [b] = r.say('them', 4000, 1)
    expect(r.sockets).toHaveLength(1)
    expect((await r.s.transcribe(b))[0].text).toBe(`chunked ${b.startMs}`)
    // quick readings go there too
    await r.s.transcribe(b, { partial: true })
    expect(r.fallback).toHaveBeenLastCalledWith(b, { partial: true })
    expect(r.logs).toHaveLength(1)
    expect(r.logs[0]).toContain('auth')
  })

  it('a model the account cannot use falls back the same way', async () => {
    const r = rig()
    const [a] = r.say('me', 0, 1)
    r.sockets[0].open()
    r.sockets[0].server({ type: 'error', event_id: 'e1', error: { type: 'invalid_request_error', code: 'model_not_found', message: 'The model does not exist or you do not have access to it.', param: 'session.audio.input.transcription.model' } })
    expect(r.s.fellBack()).toBe('model')
    expect((await r.s.transcribe(a))[0].text).toBe(`chunked ${a.startMs}`)
  })

  it('a connection that cannot be made three times running falls back', async () => {
    let t = 0
    const r = rig({ now: () => t })
    for (let i = 0; i < 3; i++) {
      t += 60_000
      const [c] = r.say('me', i * 4000, 1)
      r.sockets.at(-1)!.fail()
      expect((await r.s.transcribe(c))[0].text).toBe(`chunked ${c.startMs}`)
    }
    expect(r.sockets).toHaveLength(3)
    expect(r.s.fellBack()).toBe('connect')
    expect(r.logs).toHaveLength(1)
  })

  it('failed and late turns go chunked; three in a row fall back', async () => {
    const r = rig({ finalTimeoutMs: 30 })
    const [a] = r.say('me', 0, 1)
    const w = r.sockets[0]
    w.ready()
    w.server({ type: 'input_audio_buffer.committed', item_id: 'A', previous_item_id: null })
    w.server({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'A', content_index: 0, error: { type: 'transcription_error', code: 'audio_unintelligible', message: 'x' } })
    expect((await r.s.transcribe(a))[0].text).toBe(`chunked ${a.startMs}`)
    // never answered: late
    const [b] = r.say('me', 4000, 1)
    expect((await r.s.transcribe(b))[0].text).toBe(`chunked ${b.startMs}`)
    expect(r.s.fellBack()).toBeNull()
    const [c] = r.say('me', 8000, 1)
    expect((await r.s.transcribe(c))[0].text).toBe(`chunked ${c.startMs}`)
    expect(r.s.fellBack()).toBe('errors')
  })

  it('the key is read for each connection: none yet means chunks, one added mid-call streams from the next turn', async () => {
    let key: string | null = null
    let t = 0
    const r = rig({ key: () => key, now: () => t })
    const [a] = r.say('me', 0, 1)
    expect(r.sockets).toHaveLength(0)
    expect((await r.s.transcribe(a))[0].text).toBe(`chunked ${a.startMs}`)
    key = 'sk-added-later'
    const [b] = r.say('me', 4000, 1)
    expect(r.sockets).toHaveLength(1)
    expect(r.sockets[0].headers.Authorization).toBe('Bearer sk-added-later')
    r.sockets[0].ready()
    r.sockets[0].answer('now streaming')
    expect((await r.s.transcribe(b))[0].text).toBe('now streaming')
    // a new connection (after a drop) reads the key again
    key = 'sk-rotated'
    r.sockets[0].drop()
    t = 10_000
    r.say('me', 8000, 1)
    expect(r.sockets[1].headers.Authorization).toBe('Bearer sk-rotated')
  })

  it('speech too short to be a chunk is cleared, not committed', () => {
    const r = rig()
    r.feed('me', 0, quiet(3))
    r.feed('me', 3000, Float32Array.from([...tone(0.15), ...quiet(1.5)]))
    expect(r.chunks).toHaveLength(0)
    const w = r.sockets[0]
    w.ready()
    expect(w.of('input_audio_buffer.commit')).toHaveLength(0)
    expect(w.of('input_audio_buffer.clear')).toHaveLength(1)
  })

  it('flush commits the turn still being spoken; close shuts the sockets', async () => {
    const r = rig()
    r.feed('me', 0, tone(1))
    const w = r.sockets[0]
    w.ready()
    r.s.flush()
    expect(w.of('input_audio_buffer.commit')).toHaveLength(1)
    r.s.close()
    expect(w.closed).toBe(true)
  })

  it('logs nothing with the key, the audio or the text', async () => {
    const out: unknown[] = []
    for (const m of ['log', 'warn', 'error', 'info', 'debug'] as const) spies.push(vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { out.push(...a) }))
    const r = rig()
    const [a] = r.say('me', 0, 1)
    const w = r.sockets[0]
    w.ready()
    w.server({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'X', content_index: 0, delta: 'confidential words' })
    w.answer('confidential words in full')
    await r.s.transcribe(a)
    w.server({ type: 'error', event_id: 'e', error: { type: 'invalid_request_error', code: 'invalid_api_key', message: 'Incorrect API key provided: sk-test-key', param: null } })
    const said = [...out, ...r.logs].map(String).join('\n')
    expect(r.logs).toHaveLength(1)
    for (const secret of ['confidential', 'sk-test-key', 'Incorrect API key', String(w.of('input_audio_buffer.append')[0]?.audio).slice(0, 16)]) expect(said).not.toContain(secret)
  })
})

describe('audio conversion', () => {
  it('16 kHz becomes 24 kHz: 3 samples for every 2, across blocks', () => {
    const up = new Upsampler()
    const ramp = Float32Array.from({ length: 1600 }, (_, i) => i / 1600)
    const out = [...up.push(ramp.subarray(0, 700)), ...up.push(ramp.subarray(700))]
    expect(out.length).toBeGreaterThanOrEqual(2398)
    expect(out.length).toBeLessThanOrEqual(2400)
    // a ramp stays a ramp, also over the block edge
    for (let i = 1; i < out.length; i++) expect(out[i] - out[i - 1]).toBeCloseTo(1 / 1600 * 2 / 3, 6)
  })

  it('PCM16 little-endian, clipped', () => {
    const b = Buffer.from(pcm16Base64(Float32Array.from([0, 1, -1, 2, -2, 0.5])), 'base64')
    expect([0, 1, 2, 3, 4, 5].map((i) => b.readInt16LE(i * 2))).toEqual([0, 32767, -32768, 32767, -32768, 16384])
  })
})
