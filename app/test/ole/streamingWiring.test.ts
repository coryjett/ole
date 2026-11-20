import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Capture, encodeFrame, hookCapture, recordingFinished, type CaptureProc } from '../../src/main/capture'
import { hookTranscription, settleTranscription, stopTranscriptionServer, transcribeRecorded } from '../../src/main/asr'
import { openStore, type Meeting, type Segment, type Store } from '../../src/main/store'
import type { WsLike } from '../../src/main/ole/yogurt/openaiStream'
import { providersOf } from '../../src/main/ole/core/providers'

// #85: a live meeting transcribed by OpenAI streams, and its lines reach the store and the window in the usual shape

const RATE = 16000
const tone = (sec: number) => Float32Array.from({ length: Math.round(sec * RATE) }, (_, i) => 0.3 * Math.sin(i / 10))
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms))

function fakeProc() {
  const ev = new EventEmitter(), out = new PassThrough(), stdin = new PassThrough()
  stdin.on('data', (d: Buffer) => { if (d.toString().includes('stop')) setImmediate(() => ev.emit('exit', 0, null)) })
  const proc: CaptureProc = { stdout: out, stdin, on: (e, fn) => { ev.on(e, fn); return proc }, kill: () => { ev.emit('exit', null, 'SIGKILL'); return true } }
  return {
    proc, exit: (code: number | null) => ev.emit('exit', code, null),
    say: (track: 'me' | 'them', ms: number) => {
      const all = Float32Array.from([...tone(1), ...new Float32Array(RATE * 1.5)])
      for (let i = 0; i < all.length; i += 1600) out.write(encodeFrame({ t: 'pcm', track, ms: ms + i / 16, samples: all.subarray(i, i + 1600) }))
    },
  }
}

/** a Realtime server that is ready at once and answers each commit with "streamed <n>" */
class AutoWs implements WsLike {
  readyState = 0
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onclose: ((ev: { code?: number }) => void) | null = null
  static n = 0
  constructor(public refuse = false) { setImmediate(() => { this.readyState = 1; this.onopen?.({}) }) }
  private reply(e: object) { setImmediate(() => this.onmessage?.({ data: JSON.stringify(e) })) }
  send(d: string) {
    const e = JSON.parse(d)
    if (e.type === 'session.update') this.reply(this.refuse ? { type: 'error', error: { type: 'invalid_request_error', code: 'invalid_api_key', message: 'no' } } : { type: 'session.updated', session: {} })
    if (e.type === 'input_audio_buffer.commit') {
      const id = `item_${AutoWs.n++}`
      this.reply({ type: 'input_audio_buffer.committed', item_id: id, previous_item_id: null })
      this.reply({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, content_index: 0, transcript: `streamed ${id}` })
    }
  }
  close() { this.readyState = 3 }
}

let store: Store
beforeEach(() => { store = openStore(':memory:'); AutoWs.n = 0 })
const disposers: Array<() => void> = []
afterEach(async () => { disposers.splice(0).forEach((d) => d()); await settleTranscription(2000); stopTranscriptionServer() })
const meeting = (): Meeting => store.createMeeting({ title: 't', startedAt: 1, endedAt: null, eventId: null, app: null, attendees: [], state: 'recording' })

function rig(o: { streaming: boolean; refuse?: boolean; model?: () => string }) {
  const starts: Array<(m: Meeting) => void> = [], stops: Array<(m: Meeting) => void> = []
  const onStart = (fn: (m: Meeting) => void) => { starts.push(fn); return () => {} }
  const onStop = (fn: (m: Meeting) => void) => { stops.push(fn); return () => {} }
  const procs: ReturnType<typeof fakeProc>[] = []
  const sent: Array<Omit<Segment, 'id'>> = []
  const sockets: AutoWs[] = []
  let uploads = 0
  const models: string[] = []
  const fetch = (async (_url: unknown, init?: RequestInit) => { uploads++; models.push(String((init?.body as FormData | undefined)?.get('model'))); return new Response(JSON.stringify({ text: `chunked ${uploads}` }), { status: 200 }) }) as typeof globalThis.fetch
  disposers.push(hookTranscription({
    store, modelPath: () => undefined, useOpenAI: () => true, send: (s) => sent.push(s), warn: () => {}, holdMs: 10, onStart, onStop, pidFile: undefined,
    openai: { key: () => 'sk-x', model: o.model ?? (() => 'gpt-transcribe'), fetch, streaming: () => o.streaming, ws: () => { const w = new AutoWs(o.refuse); sockets.push(w); return w } },
  }))
  hookCapture({
    dirOf: (id) => `/m/${id}`, onStart, onStop, stopMeeting: (id) => stops.forEach((f) => f({ id } as Meeting)),
    start: (_d, opt) => { const f = fakeProc(); procs.push(f); return new Capture(f.proc, { startMs: opt?.startMs }) }, join: async () => {},
  })
  return {
    procs, sent, sockets, models, uploads: () => uploads,
    begin: (m: Meeting) => starts.forEach((f) => f(m)),
    stop: async (m: Meeting) => { stops.forEach((f) => f(m)); procs.at(-1)!.exit(0); await recordingFinished(m.id); await settleTranscription(5000) },
  }
}

describe('OpenAI streaming in a live meeting (#85)', () => {
  it('lines are streamed, saved and sent like chunked ones: same track, timing and speaker fields', async () => {
    const r = rig({ streaming: true })
    const m = meeting()
    r.begin(m)
    r.procs[0].say('me', 500)
    r.procs[0].say('them', 5000)
    await tick(100)
    await r.stop(m)
    const saved = store.segments(m.id)
    expect(saved.map((s) => [s.track, s.text])).toEqual([['me', 'streamed item_0'], ['them', 'streamed item_1']])
    expect(r.uploads()).toBe(0)
    expect(r.sockets).toHaveLength(2)
    // timed by the chunk on the meeting clock, as the chunked transcriber does
    expect(saved[0].startMs).toBeGreaterThanOrEqual(500)
    expect(saved[0].startMs).toBeLessThan(700)
    expect(saved[1].startMs).toBeGreaterThanOrEqual(5000)
    expect(saved[0].speaker).toBe('me')
    expect(r.sent.map((s) => Object.keys(s).sort())).toEqual(saved.map(() => ['endMs', 'meetingId', 'speaker', 'startMs', 'text', 'track']))
    expect(store.meeting(m.id)?.transcriptionPending).not.toBe(true)
  })

  it('a refused key: the meeting is still transcribed, in chunks', async () => {
    const r = rig({ streaming: true, refuse: true })
    const m = meeting()
    r.begin(m)
    r.procs[0].say('them', 500)
    await tick(100)
    await r.stop(m)
    expect(store.segments(m.id).map((s) => s.text)).toEqual(['chunked 1'])
  })

  it('the fallback uses the chunked default, gpt-transcribe, even when the saved model is retiring (#89)', async () => {
    for (const saved of [{}, { oleTranscribeModel: 'gpt-4o-mini-transcribe' }]) {
      // as index.ts wires it: the model is read from the providers on every chunk
      const r = rig({ streaming: true, refuse: true, model: () => providersOf(saved).openaiTranscribeModel })
      const m = meeting()
      r.begin(m)
      r.procs[0].say('them', 500)
      await tick(100)
      await r.stop(m)
      expect(r.uploads()).toBeGreaterThan(0)
      expect(new Set(r.models)).toEqual(new Set(['gpt-transcribe']))
      disposers.splice(0).forEach((d) => d())
    }
  })

  it('streaming off uses the chunked transcriber, with no connection', async () => {
    const r = rig({ streaming: false })
    const m = meeting()
    r.begin(m)
    r.procs[0].say('them', 500)
    await tick(100)
    await r.stop(m)
    expect(store.segments(m.id).map((s) => s.text)).toEqual(['chunked 1'])
    expect(r.sockets).toHaveLength(0)
  })

  it('a saved recording is transcribed in chunks, never streamed', async () => {
    const r = rig({ streaming: true })
    const m = meeting()
    async function* audio() { yield Float32Array.from([...tone(1), ...new Float32Array(RATE * 1.5)]) }
    expect(await transcribeRecorded(m.id, { them: audio() })).toBe(true)
    expect(r.sockets).toHaveLength(0)
    expect(store.segments(m.id).map((s) => s.text)).toEqual(['chunked 1'])
  })
})
