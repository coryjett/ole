// Ole: replay a saved call through the live bullets engine and measure what it shows (#66).
// Dev only: scripts/ole-replay.mjs and the tests import this; nothing in the app does (a test pins that).
import { callKey, createBulletsEngine, generalTools, hasMatchedRecord, parseBullets, type CallToolFn, type ChatFn, type ChatMessage, type ToolCall, type TranscriptLine } from './bullets'
import { isLiveTool } from './tools'
import type { OleBullet, OleTool, PreparedContext } from './types'
import { classifyFailure, type FailureKind, type ReplayFixture } from './replayFormat'

// the fixture format lives in replayFormat.ts, so the app's export (#70) can build fixtures without importing the harness
export { classifyFailure, type FailureKind, type ReplayFixture, type ReplayReply, type ReplayToolCall, type ReplayTurn } from './replayFormat'

export type TurnReport = { atMs: number; back: number; shown: number; withoutSource: number; repeated: number; lookups: number; failed?: FailureKind
  /** brought forward by a question or a new term from the other side (#79) */
  fast?: boolean }
export type ShownBullet = { atMs: number; text: string; source: string; words: number; heard: boolean; quote: boolean; url: boolean }
export type ReplayReport = {
  call: string
  durationMs: number
  lines: number
  /** fast: turns a question or a new term brought forward (#79) */
  turns: { total: number; failed: number; unrecorded: number; fast: number }
  bullets: { back: number; shown: number; withoutSource: number; repeated: number }
  /** of the bullets shown: excerpts the model gave and how many of them Ole could verify */
  excerpts: { heard: { given: number; verified: number }; quote: { given: number; verified: number }; url: { given: number; kept: number } }
  headlines: { minWords: number; medianWords: number; maxWords: number; maxChars: number; overTenWords: number; cut: number }
  /** the longest part of the call with no new bullet: from the start, between bullets, or to the end */
  quiet: { longestMs: number; fromMs: number; toMs: number; firstBulletMs: number | null }
  /** asked: lookups the model asked for; made: reached the server; refused: blocked by the engine (repeat, rate, unknown) */
  lookups: { asked: number; made: number; refused: number; unrecorded: number }
  timeline: TurnReport[]
  shown: ShownBullet[]
}

/** the engine's per-turn log line (#59), parsed; null for anything else */
export function parseTurnLog(line: string): Omit<TurnReport, 'atMs'> | null {
  const ok = line.match(/^ole bullets: (\d+) back, (\d+) shown, (\d+) without a source, (\d+) repeated, (\d+) lookups(, fast)?$/)
  if (ok) {
    const [back, shown, withoutSource, repeated, lookups] = ok.slice(1, 6).map(Number)
    return { back, shown, withoutSource, repeated, lookups, ...(ok[6] ? { fast: true } : {}) }
  }
  const failed = line.match(/^ole bullets: turn failed: (.*)$/)
  return failed ? { back: 0, shown: 0, withoutSource: 0, repeated: 0, lookups: 0, failed: classifyFailure(failed[1]) } : null
}

/**
 * The --live ChatFn: only the request fields the engine sends go through, and the validated key, model and base URL
 * are pinned last, so nothing in a request can redirect it or swap the key.
 */
export function liveChat(send: (o: { messages: ChatMessage[]; tools?: unknown[]; response_format?: unknown; key: string; model: string; baseUrl: string }) => Promise<{ content: string | null; tool_calls?: ToolCall[] }>, pinned: { key: string; model: string; baseUrl: string }): ChatFn {
  return (req) => send({ messages: req.messages, tools: req.tools, response_format: req.response_format, key: pinned.key, model: pinned.model, baseUrl: pinned.baseUrl })
}

/** every exact occurrence of each secret (an API key, say) taken out of text that is about to be printed */
export function scrub(text: string, secrets: Array<string | null | undefined>): string {
  return secrets.filter((x): x is string => !!x && x.length >= 4).reduce((t, x) => t.split(x).join('[key]'), text)
}

/** the tools the app would offer this call (#57): lookup-style only, and no single-record lookups on a call with no matching record */
export function liveToolsFor(tools: OleTool[], context: PreparedContext | null): OleTool[] {
  const live = tools.filter(isLiveTool)
  return hasMatchedRecord(context) ? live : generalTools(live)
}

/** engine settings a fixture may set, clamped to sane ranges; anything else in the fixture is ignored */
export function replaySettings(s: unknown): { minIntervalMs?: number; fastMinMs?: number; windowMs?: number; maxLookupsPerMinute?: number } {
  const o = s && typeof s === 'object' && !Array.isArray(s) ? s as Record<string, unknown> : {}
  const pick = (k: string, min: number, max: number) => typeof o[k] === 'number' && Number.isFinite(o[k]) ? { [k]: Math.min(max, Math.max(min, o[k] as number)) } : {}
  return { ...pick('minIntervalMs', 1_000, 600_000), ...pick('fastMinMs', 0, 600_000), ...pick('windowMs', 10_000, 1_800_000), ...pick('maxLookupsPerMinute', 0, 20) }
}

/** a clock and timers that only move when the replay moves them */
export function virtualClock() {
  let t = 0, seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => t,
    timers: {
      set: (fn: () => void, ms: number): unknown => { const id = ++seq; timers.set(id, { at: t + Math.max(0, ms), fn }); return id },
      clear: (h: unknown) => { timers.delete(h as number) },
    },
    pending: () => timers.size,
    /** runs every timer due by `to`, in time order, letting each one's promises settle before the next */
    async advanceTo(to: number, settle: () => Promise<void>) {
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | undefined
        for (const e of timers) if (e[1].at <= to && (!next || e[1].at < next[1].at || (e[1].at === next[1].at && e[0] < next[0]))) next = e
        if (!next) break
        timers.delete(next[0])
        t = Math.max(t, next[1].at)
        next[1].fn()
        await settle()
      }
      t = Math.max(t, to)
    },
  }
}

const offered = (names: string[]): OleTool[] => names.map(name => {
  const [serverId, tool] = name.includes('__') ? [name.split('__')[0], name.split('__').slice(1).join('__')] : ['replay', name]
  return { name, serverId, serverName: serverId, tool, description: `[${serverId}] ${tool}`, parameters: { type: 'object', properties: { query: { type: 'string' } } } }
})

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length
const median = (xs: number[]) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * Replays a fixture through createBulletsEngine on a virtual clock: each line arrives at its startMs, the throttle and
 * the model's latency run on the same clock, and the recording stops at endMs. With `chat`, a real model answers
 * instead of the recorded replies (the lookups still answer from the fixture).
 */
export async function replayCall(fixture: ReplayFixture, opts: { chat?: ChatFn } = {}): Promise<ReplayReport> {
  const clock = virtualClock()
  const lines = [...fixture.transcript].sort((a, b) => a.startMs - b.startMs)
  const endMs = fixture.endMs ?? (lines.at(-1)?.startMs ?? 0) + 5_000
  const live = new Set<Promise<unknown>>()
  const settle = async () => {
    for (;;) {
      await new Promise<void>(r => setImmediate(r))
      if (!live.size) return
      await Promise.allSettled([...live])
    }
  }

  // lookups answer from what was recorded: this turn's first, then any turn's (a live model may ask in another turn)
  const results = new Map<string, string>()
  const turnResults: Array<Map<string, string>> = fixture.turns.map(t => {
    const m = new Map<string, string>()
    for (const r of t.replies) for (const c of r.toolCalls ?? []) if (c.result !== undefined) {
      const key = callKey(c.name, c.arguments ?? {})
      m.set(key, c.result)
      if (!results.has(key)) results.set(key, c.result)
    }
    return m
  })

  type Turn = { atMs: number; last: string | null; log?: Omit<TurnReport, 'atMs'>; fresh: OleBullet[] }
  const turns: Turn[] = []
  let unrecordedTurns = 0, made = 0, unrecordedLookups = 0, callSeq = 0

  const recorded: ChatFn = (req) => {
    const turn = turns.length - 1
    const step = req.messages.filter(m => m.role === 'assistant').length
    const reply = fixture.turns[turn]?.replies[step]
    if (!reply) {
      if (step === 0) unrecordedTurns++
      return Promise.resolve({ content: '{"bullets":[]}' })
    }
    const answer = () => {
      if (reply.error !== undefined) throw new Error(reply.error)
      const tool_calls: ToolCall[] | undefined = reply.toolCalls?.length
        ? reply.toolCalls.map(c => ({ id: `call_${++callSeq}`, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) } }))
        : undefined
      const content = reply.bullets ? JSON.stringify({ bullets: reply.bullets }) : reply.content ?? (tool_calls ? null : '{"bullets":[]}')
      return { content, ...(tool_calls ? { tool_calls } : {}) }
    }
    const latency = reply.latencyMs ?? fixture.latencyMs ?? 0
    if (latency <= 0) return Promise.resolve().then(answer)
    return new Promise((resolve, reject) => clock.timers.set(() => { try { resolve(answer()) } catch (e) { reject(e) } }, latency))
  }

  const chat: ChatFn = async (req) => {
    const last = req.messages.at(-1)
    if (last?.role === 'user') turns.push({ atMs: clock.now(), last: null, fresh: [] })
    const p = opts.chat ? opts.chat(req) : recorded(req)
    if (opts.chat) { live.add(p); void p.finally(() => live.delete(p)).catch(() => {}) }
    const reply = await p
    const turn = turns.at(-1)
    if (turn && !reply.tool_calls?.length) turn.last = reply.content
    return reply
  }

  const callTool: CallToolFn = async (name, argsJson) => {
    made++
    const key = callKey(name, JSON.parse(argsJson))
    const hit = turnResults[turns.length - 1]?.get(key) ?? results.get(key)
    if (hit === undefined) { unrecordedLookups++; return 'no result' }
    return hit
  }

  const context: PreparedContext = { meetingTitle: fixture.briefing.meetingTitle ?? null, focus: fixture.briefing.focus ?? null, text: fixture.briefing.text, preparedAt: 0 }
  const seen = new Set<string>()
  const engine = createBulletsEngine({
    chat,
    tools: () => liveToolsFor(offered(fixture.tools ?? []), context),
    callTool,
    context: () => context,
    onBullets: all => {
      const turn = turns.at(-1)
      for (const b of all) if (!seen.has(b.id)) { seen.add(b.id); turn?.fresh.push(b) }
    },
    log: line => { const t = turns.at(-1); const parsed = parseTurnLog(line); if (t && parsed) t.log = parsed },
    now: clock.now,
    timers: clock.timers,
    ...replaySettings(fixture.settings),
  })

  for (const line of lines) {
    if (line.startMs > endMs) break
    await clock.advanceTo(line.startMs, settle)
    engine.push(line)
    await settle()
  }
  await clock.advanceTo(endMs, settle)
  engine.stop()
  await settle()

  // a turn the recording stopped in the middle of never reached the panel, so it is not counted
  const done = turns.filter(t => t.log)
  const timeline: TurnReport[] = done.map(t => ({ atMs: t.atMs, ...t.log! }))
  const shown: ShownBullet[] = []
  const excerpts = { heard: { given: 0, verified: 0 }, quote: { given: 0, verified: 0 }, url: { given: 0, kept: 0 } }
  for (const t of done) {
    const raw = parseBullets(t.last)
    for (const b of t.fresh) {
      // what the model gave for this bullet, before the engine checked its excerpts
      const given = raw.find(r => r.text === b.text)
      if (given?.heard) excerpts.heard.given++
      if (given?.quote) excerpts.quote.given++
      if (given?.url) excerpts.url.given++
      if (b.heard) excerpts.heard.verified++
      if (b.quote) excerpts.quote.verified++
      if (b.url) excerpts.url.kept++
      shown.push({ atMs: b.at, text: b.text, source: b.source, words: words(b.text), heard: !!b.heard, quote: !!b.quote, url: !!b.url })
    }
  }

  const counts = shown.map(s => s.words)
  const marks = [0, ...shown.map(s => Math.min(s.atMs, endMs)).sort((a, b) => a - b), endMs]
  let quiet = { longestMs: 0, fromMs: 0, toMs: 0 }
  for (let i = 1; i < marks.length; i++) if (marks[i] - marks[i - 1] > quiet.longestMs) quiet = { longestMs: marks[i] - marks[i - 1], fromMs: marks[i - 1], toMs: marks[i] }
  const asked = timeline.reduce((n, t) => n + t.lookups, 0)
  const sum = (k: 'back' | 'shown' | 'withoutSource' | 'repeated') => timeline.reduce((n, t) => n + t[k], 0)

  return {
    call: fixture.name,
    durationMs: endMs,
    lines: lines.filter(l => l.startMs <= endMs).length,
    turns: { total: timeline.length, failed: timeline.filter(t => t.failed !== undefined).length, unrecorded: unrecordedTurns, fast: timeline.filter(t => t.fast).length },
    bullets: { back: sum('back'), shown: sum('shown'), withoutSource: sum('withoutSource'), repeated: sum('repeated') },
    excerpts,
    headlines: {
      minWords: counts.length ? Math.min(...counts) : 0,
      medianWords: median(counts),
      maxWords: counts.length ? Math.max(...counts) : 0,
      maxChars: shown.reduce((n, s) => Math.max(n, s.text.length), 0),
      overTenWords: counts.filter(n => n > 10).length,
      cut: shown.filter(s => s.text.endsWith('…')).length,
    },
    quiet: { ...quiet, firstBulletMs: shown.length ? Math.min(...shown.map(s => s.atMs)) : null },
    lookups: { asked, made, refused: asked - made, unrecorded: unrecordedLookups },
    timeline,
    shown,
  }
}

const mmss = (ms: number) => {
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** a few lines a person can read; the JSON report has the rest */
export function summarise(r: ReplayReport): string {
  const h = r.headlines, e = r.excerpts
  return [
    `${r.call}: ${mmss(r.durationMs)} call, ${r.lines} lines`,
    `  turns ${r.turns.total} (${r.turns.failed} failed, ${r.turns.unrecorded} unrecorded, ${r.turns.fast} fast); lookups ${r.lookups.asked} asked, ${r.lookups.made} made, ${r.lookups.refused} refused`,
    `  bullets ${r.bullets.back} back, ${r.bullets.shown} shown, ${r.bullets.withoutSource} without a source, ${r.bullets.repeated} repeated`,
    `  excerpts: heard ${e.heard.verified}/${e.heard.given} verified, quote ${e.quote.verified}/${e.quote.given} verified, links ${e.url.kept}/${e.url.given} kept`,
    r.shown.length
      ? `  headlines: ${h.minWords} to ${h.maxWords} words (median ${h.medianWords}), longest ${h.maxChars} chars, ${h.overTenWords} over ten words, ${h.cut} cut`
      : '  headlines: none shown',
    `  quiet: longest ${mmss(r.quiet.longestMs)} with nothing new (${mmss(r.quiet.fromMs)} to ${mmss(r.quiet.toMs)}); first bullet ${r.quiet.firstBulletMs === null ? 'never' : `at ${mmss(r.quiet.firstBulletMs)}`}`,
  ].join('\n')
}
