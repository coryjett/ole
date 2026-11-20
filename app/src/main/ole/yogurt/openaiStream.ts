import type { Track } from '../../capture'
import { chunker, type Chunk } from '../../asr/chunker'
import type { Line, Transcribe } from '../../asr/transcribe'
import { pcm16Base64, Upsampler } from '../core/pcm'

export { pcm16Base64, Upsampler }

/**
 * Ole: streaming transcription over OpenAI's Realtime API (#85), behind Yogurt's Transcribe seam.
 *
 * One WebSocket per track per recording (`wss://api.openai.com/v1/realtime?intent=transcription`, a transcription-only
 * session with `gpt-live-transcribe`, which takes no server VAD). Ole is the VAD: the same chunker the pipeline runs
 * sees the same audio, so a turn here starts and ends where the pipeline's chunk does. Speech is appended as it is heard
 * (24 kHz PCM16), the turn is committed when its chunk closes, and the pipeline's request for that chunk waits for the
 * turn's final text instead of uploading the audio again. Quick readings (partials) return the deltas heard so far.
 *
 * Lines keep the chunked transcriber's shape: one line per chunk, timed by the chunk on the meeting clock.
 *
 * Any trouble sends a chunk the chunked way (`fallback`): no key yet, a connection still opening or backing off after a
 * drop, a failed or late turn. An auth or model refusal, a connection that can't be made three times running, or errors
 * that keep coming switch the rest of the recording to the chunked transcriber, logged once. Logs never hold audio,
 * text or the key.
 */

export const STREAM_MODEL = 'gpt-live-transcribe'
export const REALTIME_URL = 'wss://api.openai.com/v1/realtime?intent=transcription'
/** the Realtime API takes PCM16 at 24 kHz only */
const OUT_RATE = 24000

/** the parts of a WebSocket used here (WHATWG shape: Node's global WebSocket, or a test's stand-in) */
export type WsLike = {
  readyState: number
  send(data: string): void
  close(code?: number): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: ((ev: unknown) => void) | null
  onclose: ((ev: { code?: number }) => void) | null
}
export type WsFactory = (url: string, headers: Record<string, string>) => WsLike

/** Node's (and Electron's) global WebSocket is undici's, which takes headers as an extension of the second argument */
const nodeWs: WsFactory = (url, headers) => {
  const Ws = (globalThis as unknown as { WebSocket: new (u: string, o: unknown) => WsLike }).WebSocket
  return new Ws(url, { headers })
}

export type FallbackReason = 'auth' | 'model' | 'connect' | 'dropped' | 'errors'

type Opts = {
  /** read for each connection, so a key added mid-call counts from the next turn */
  key: () => string | null
  /** the chunked transcriber: any chunk the stream can't give */
  fallback: Transcribe
  model?: string
  url?: string
  ws?: WsFactory
  /** one line when the recording falls back for good (default console.warn) */
  log?: (line: string) => void
  now?: () => number
  /** how long a final waits for its streamed text before the chunk goes the chunked way */
  finalTimeoutMs?: number
  /** how long a connection may take to be ready */
  connectTimeoutMs?: number
  /** how long a final waits for its turn to be known (the chunk usually is, already) */
  lookupMs?: number
}

export type Streaming = {
  transcribe: Transcribe
  /** the track's audio as captured (16 kHz, meeting time), before the pipeline gets it */
  push(track: Track, ms: number, samples: Float32Array): void
  /** the recording ended: the last turn is committed */
  flush(): void
  /** after the pipeline finished: connections go */
  close(): void
  /** for tests and the log: whether the recording still streams */
  fellBack(): FallbackReason | null
}

type Turn = {
  track: Track
  conn: Conn | null
  status: 'open' | 'committed' | 'done' | 'lost'
  /** the chunk's start and end, once it closed */
  startMs?: number
  endMs?: number
  itemId?: string
  /** deltas so far */
  text: string
  final?: string
  waiters: Array<() => void>
}

type Conn = {
  ws: WsLike
  ready: boolean
  dead: boolean
  /** messages waiting for the session to be ready */
  queue: string[]
  /** open and committed turns, oldest first, until their final */
  turns: Turn[]
  items: Map<string, Turn>
  up: Upsampler
  timer?: NodeJS.Timeout
}

type TrackState = {
  conn: Conn | null
  open: Turn | null
  /** turns whose chunk closed, waiting for the pipeline to ask for them */
  cut: Turn[]
  /** a little audio before a turn opens, so its first sound isn't clipped */
  preroll: Float32Array[]
  nextTryAt: number
  lookups: Array<{ startMs: number; resolve: (t: Turn | undefined) => void }>
}

/** 0.3 s at 16 kHz, as the chunked transcriber: too short to hold a word */
const MIN_SAMPLES = 4800
const PREROLL_SAMPLES = 16000 * 0.3
/** setup failures in a row before the recording falls back */
const MAX_SETUP_FAILS = 3
/** drops of a working connection in one recording before it falls back */
const MAX_DROPS = 5
/** failed or late turns in a row before it falls back */
const MAX_TURN_FAILS = 3
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000]

export function createOpenAIStreaming(o: Opts): Streaming {
  const url = o.url ?? REALTIME_URL
  const model = o.model ?? STREAM_MODEL
  const makeWs = o.ws ?? nodeWs
  const log = o.log ?? ((l: string) => console.warn(l))
  const now = o.now ?? Date.now
  const finalTimeoutMs = o.finalTimeoutMs ?? 10_000
  const connectTimeoutMs = o.connectTimeoutMs ?? 10_000
  const lookupMs = o.lookupMs ?? 1000

  const tracks: Record<Track, TrackState> = {
    me: { conn: null, open: null, cut: [], preroll: [], nextTryAt: 0, lookups: [] },
    them: { conn: null, open: null, cut: [], preroll: [], nextTryAt: 0, lookups: [] },
  }
  let fell: FallbackReason | null = null
  let closed = false
  let setupFails = 0
  let drops = 0
  let turnFails = 0

  const settle = (t: Turn, status: 'done' | 'lost') => {
    if (t.status === 'done' || t.status === 'lost') return
    t.status = status
    if (t.conn) t.conn.turns = t.conn.turns.filter((x) => x !== t)
    for (const w of t.waiters.splice(0)) w()
  }

  const loseAll = (c: Conn) => { for (const t of [...c.turns]) settle(t, 'lost') }

  const shut = (c: Conn) => {
    c.dead = true
    clearTimeout(c.timer)
    loseAll(c)
    try { c.ws.close(1000) } catch { /* already gone */ }
  }

  const fallBack = (reason: FallbackReason) => {
    if (fell) return
    fell = reason
    log(`ole: streaming transcription off for this recording (${reason}); chunked transcription takes over`)
    for (const st of Object.values(tracks)) {
      if (st.conn) shut(st.conn)
      st.conn = null
      if (st.open) settle(st.open, 'lost')
    }
  }

  const turnFailed = () => { if (++turnFails >= MAX_TURN_FAILS) fallBack('errors') }

  const connect = (track: Track): Conn | null => {
    const key = o.key()
    if (!key) return null
    let ws: WsLike
    try { ws = makeWs(url, { Authorization: `Bearer ${key}` }) } catch { setupFailed(track); return null }
    const c: Conn = { ws, ready: false, dead: false, queue: [], turns: [], items: new Map(), up: new Upsampler() }
    c.timer = setTimeout(() => { if (!c.ready && !c.dead) { shut(c); setupFailed(track) } }, connectTimeoutMs)
    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'session.update',
        session: { type: 'transcription', audio: { input: { format: { type: 'audio/pcm', rate: OUT_RATE }, transcription: { model }, turn_detection: null } } },
      }))
    }
    ws.onmessage = (ev) => onEvent(track, c, ev.data)
    ws.onerror = () => { /* onclose follows */ }
    ws.onclose = () => {
      if (c.dead) return
      const wasReady = c.ready
      shut(c)
      if (tracks[track].conn === c) tracks[track].conn = null
      if (closed || fell) return
      if (!wasReady) return setupFailed(track)
      drops++
      if (drops >= MAX_DROPS) return fallBack('dropped')
      tracks[track].nextTryAt = now() + BACKOFF_MS[Math.min(drops - 1, BACKOFF_MS.length - 1)]
    }
    return c
  }

  const setupFailed = (track: Track) => {
    setupFails++
    if (setupFails >= MAX_SETUP_FAILS) return fallBack('connect')
    tracks[track].nextTryAt = now() + BACKOFF_MS[Math.min(setupFails - 1, BACKOFF_MS.length - 1)]
  }

  const onEvent = (track: Track, c: Conn, data: unknown) => {
    if (c.dead) return
    let e: { type?: string; item_id?: string; delta?: string; transcript?: string; error?: { type?: string; code?: string | null; param?: string | null } }
    try { e = JSON.parse(typeof data === 'string' ? data : String(data)) } catch { return }
    switch (e.type) {
      case 'session.updated':
        if (c.ready) return
        c.ready = true
        clearTimeout(c.timer)
        setupFails = 0
        for (const m of c.queue.splice(0)) c.ws.send(m)
        return
      case 'input_audio_buffer.committed': {
        if (!e.item_id || c.items.has(e.item_id)) return
        const t = c.turns.find((x) => x.status === 'committed' && !x.itemId)
        if (t) { t.itemId = e.item_id; c.items.set(e.item_id, t) }
        return
      }
      case 'conversation.item.input_audio_transcription.delta': {
        if (!e.item_id || typeof e.delta !== 'string') return
        let t = c.items.get(e.item_id)
        // deltas come while the turn is still being spoken, before its commit names the item
        if (!t) { t = c.turns.find((x) => !x.itemId); if (!t) return; t.itemId = e.item_id; c.items.set(e.item_id, t) }
        t.text += e.delta
        return
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const t = e.item_id ? c.items.get(e.item_id) : undefined
        if (!t) return
        c.items.delete(e.item_id!)
        t.final = typeof e.transcript === 'string' ? e.transcript : t.text
        turnFails = 0
        settle(t, 'done')
        return
      }
      case 'conversation.item.input_audio_transcription.failed': {
        const t = e.item_id ? c.items.get(e.item_id) : undefined
        if (t) { c.items.delete(e.item_id!); settle(t, 'lost') }
        turnFailed()
        return
      }
      case 'error': {
        const code = `${e.error?.code ?? ''} ${e.error?.type ?? ''}`
        const param = `${e.error?.param ?? ''}`
        if (/api_key|auth|permission|insufficient_quota|billing/i.test(code)) return fallBack('auth')
        if (/model/i.test(code) || /model/i.test(param)) return fallBack('model')
        if (!c.ready) { shut(c); if (tracks[track].conn === c) tracks[track].conn = null; return setupFailed(track) }
        turnFailed()
        return
      }
    }
  }

  /** the track's connection, made if need be; null: this turn goes the chunked way */
  const connFor = (track: Track): Conn | null => {
    const st = tracks[track]
    if (fell || closed) return null
    if (st.conn && !st.conn.dead) return st.conn
    if (now() < st.nextTryAt) return null
    st.conn = connect(track)
    return st.conn
  }

  const sendOn = (c: Conn, msg: object) => {
    if (c.dead) return
    const s = JSON.stringify(msg)
    if (!c.ready) { c.queue.push(s); return }
    try { c.ws.send(s) } catch { /* onclose follows */ }
  }

  const append = (t: Turn, samples: Float32Array) => {
    const c = t.conn
    if (!c || c.dead || t.status !== 'open' || !samples.length) return
    sendOn(c, { type: 'input_audio_buffer.append', audio: pcm16Base64(c.up.push(samples)) })
  }

  const startTurn = (track: Track): Turn => {
    const st = tracks[track]
    const conn = connFor(track)
    const t: Turn = { track, conn, status: conn ? 'open' : 'lost', text: '', waiters: [] }
    if (conn) { conn.turns.push(t); conn.up.reset() }
    st.open = t
    for (const p of st.preroll) append(t, p)
    st.preroll = []
    return t
  }

  const cutTurn = (track: Track, c: Chunk) => {
    const st = tracks[track]
    const t = st.open ?? startTurn(track)
    st.open = null
    t.startMs = c.startMs
    t.endMs = c.startMs + c.samples.length / 16
    if (t.status === 'open' && t.conn && !t.conn.dead) { t.status = 'committed'; sendOn(t.conn, { type: 'input_audio_buffer.commit' }) } else settle(t, 'lost')
    st.cut.push(t)
    if (st.cut.length > 50) st.cut.shift()
    const l = st.lookups.find((x) => x.startMs === c.startMs)
    if (l) { st.lookups = st.lookups.filter((x) => x !== l); l.resolve(take(track, c)) }
  }

  const dropTurn = (track: Track) => {
    const st = tracks[track], t = st.open
    st.open = null
    if (!t) return
    if (t.status === 'open' && t.conn && !t.conn.dead) sendOn(t.conn, { type: 'input_audio_buffer.clear' })
    settle(t, 'lost')
  }

  const keepPreroll = (st: TrackState, samples: Float32Array) => {
    st.preroll.push(samples)
    let n = st.preroll.reduce((s, x) => s + x.length, 0)
    while (st.preroll.length > 1 && n - st.preroll[0].length >= PREROLL_SAMPLES) n -= st.preroll.shift()!.length
  }

  /** the turn standing for a chunk: the same start (the chunkers saw the same audio), older unasked turns go */
  const take = (track: Track, c: Chunk): Turn | undefined => {
    const st = tracks[track]
    const i = st.cut.findIndex((t) => t.startMs === c.startMs)
    if (i < 0) return undefined
    const t = st.cut[i]
    st.cut = st.cut.slice(i + 1)
    return t
  }

  const emitted: Chunk[] = []
  const cut = chunker((c) => emitted.push(c))

  const lineOf = (c: Chunk, text: string): Line[] => {
    const said = text.replace(/\s+/g, ' ').trim()
    return said ? [{ track: c.track, startMs: c.startMs, endMs: c.startMs + Math.round(c.samples.length / 16), text: said }] : []
  }

  /** read through a call: the status changes while a final waits */
  const isDone = (t: Turn) => t.status === 'done'

  const transcribe: Transcribe = async (c, opts) => {
    if (opts?.partial) {
      if (fell) return o.fallback(c, opts)
      const t = tracks[c.track].open
      return t && t.status === 'open' ? lineOf(c, t.text) : []
    }
    let t = take(c.track, c)
    if (!t && !fell && !closed) {
      t = await new Promise<Turn | undefined>((resolve) => {
        const l = { startMs: c.startMs, resolve }
        tracks[c.track].lookups.push(l)
        setTimeout(() => { const st = tracks[c.track]; if (st.lookups.includes(l)) { st.lookups = st.lookups.filter((x) => x !== l); resolve(undefined) } }, lookupMs)
      })
    }
    if (c.samples.length < MIN_SAMPLES) return []
    if (!t || t.status === 'lost') return o.fallback(c)
    if (t.status !== 'done') {
      let late = false
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { late = true; resolve() }, finalTimeoutMs)
        t!.waiters.push(() => { clearTimeout(timer); resolve() })
      })
      if (late && !isDone(t)) { settle(t, 'lost'); turnFailed() }
    }
    if (!isDone(t)) return o.fallback(c)
    return lineOf(c, t.final ?? '')
  }

  return {
    transcribe,
    push(track, ms, samples) {
      if (fell || closed || !samples.length) return
      const st = tracks[track]
      const wasOpen = cut.isOpen(track)
      emitted.length = 0
      cut.push(track, ms, samples)
      const isOpen = cut.isOpen(track)
      const mine = emitted.filter((c) => c.track === track)
      if (!wasOpen && !isOpen && !mine.length) { keepPreroll(st, samples); return }
      if (!st.open) {
        // the frame opening a turn is in the preroll's last place, so it goes out with it
        keepPreroll(st, samples)
        startTurn(track)
      } else append(st.open, samples)
      for (const c of mine) cutTurn(track, c)
      if (isOpen && !st.open) startTurn(track)
      // closed without a chunk (too little speech to count): its audio is dropped there too
      if (!isOpen && st.open) dropTurn(track)
    },
    flush() {
      if (fell || closed) return
      emitted.length = 0
      cut.flush()
      for (const c of emitted.splice(0)) cutTurn(c.track, c)
      for (const track of ['me', 'them'] as const) if (tracks[track].open) dropTurn(track)
    },
    close() {
      closed = true
      for (const st of Object.values(tracks)) {
        if (st.conn) shut(st.conn)
        st.conn = null
        if (st.open) settle(st.open, 'lost')
        for (const l of st.lookups.splice(0)) l.resolve(undefined)
      }
    },
    fellBack: () => fell,
  }
}
