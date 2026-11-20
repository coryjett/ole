// Ole: live context bullets. Throttled model calls over the recent transcript and the prepared context.
import type { OleBullet, PreparedContext } from './types'

export type TranscriptLine = { speaker: string; text: string; startMs: number }
export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } }
export type ChatMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string }
export type ChatFn = (req: { messages: ChatMessage[]; tools?: unknown[]; response_format?: unknown }) => Promise<{ content: string | null; tool_calls?: ToolCall[] }>
export type SearchCallsFn = (query: string) => Promise<string>
export type BulletsEngine = { push(line: TranscriptLine): void; stop(): void; bullets(): OleBullet[] }

const WINDOW_MS = 180_000
const TOOL_ROUNDS = 2
const PREVIOUS_IN_PROMPT = 30
const MAX_LINES = 2000

export const SEARCH_CALLS_TOOL = {
  type: 'function',
  function: {
    name: 'search_calls',
    description: 'Search Siesta call transcripts across all accounts for how other customers handled a topic.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'A short topic, such as a product, problem or competitor' } }, required: ['query'] },
  },
} as const

/** Lines from the last `windowMs` before the newest line. */
export function recentWindow(lines: TranscriptLine[], windowMs = WINDOW_MS): TranscriptLine[] {
  const last = lines.at(-1)
  return last ? lines.filter(l => l.startMs >= last.startMs - windowMs) : []
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export const BULLETS_SYSTEM = [
  'You help a Solo.io sales engineer during a live customer call by surfacing short context bullets they can glance at.',
  'Reply with JSON only: {"bullets":[{"text":"...","source":"..."}]}.',
  'Give 0 to 3 NEW bullets, each under 20 words.',
  'Every bullet must cite its source: the section of the prepared context it came from, or the search_calls result it came from. With no source, give no bullet. Never invent facts.',
  'Never repeat or rephrase an earlier bullet.',
  'Anonymise other customers by industry and size, for example "a large financial services customer". Never name another customer; only the current account may be named.',
  'Answer from the prepared context first. Call search_calls only for gaps, such as another customer\'s experience or a competitor with no notes.',
  'When nothing useful applies, reply {"bullets":[]}.',
].join('\n')

/** The system and user messages for one bullets turn. */
export function buildBulletsPrompt(args: { context: PreparedContext | null; lines: TranscriptLine[]; previous: OleBullet[] }): ChatMessage[] {
  const { context, lines, previous } = args
  const parts: string[] = []
  if (context?.accountName) parts.push(`Prepared context for ${context.accountName}${context.meetingTitle ? ` (meeting: ${context.meetingTitle})` : ''}:\n${context.text}`)
  else parts.push(`No account prepared.${context?.meetingTitle ? ` Meeting: ${context.meetingTitle}` : ''}${context?.text ? `\n${context.text}` : ''}`)
  const earlier = previous.slice(0, PREVIOUS_IN_PROMPT)
  parts.push(earlier.length ? `Earlier bullets (do not repeat):\n${earlier.map(b => `- ${b.text}`).join('\n')}` : 'Earlier bullets: none')
  parts.push(`Transcript (last few minutes):\n${lines.map(l => `[${clock(l.startMs)}] ${l.speaker}: ${l.text}`).join('\n')}`)
  return [{ role: 'system', content: BULLETS_SYSTEM }, { role: 'user', content: parts.join('\n\n') }]
}

/** Bullets with both text and source from a model reply; anything malformed is dropped, never thrown. */
export function parseBullets(content: string | null): Array<{ text: string; source: string }> {
  if (!content) return []
  const body = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { return [] }
  const list = (parsed as { bullets?: unknown })?.bullets
  if (!Array.isArray(list)) return []
  const out: Array<{ text: string; source: string }> = []
  for (const item of list) {
    const text = typeof item?.text === 'string' ? item.text.trim() : ''
    const source = typeof item?.source === 'string' ? item.source.trim() : ''
    if (text && source) out.push({ text, source })
    if (out.length === 3) break
  }
  return out
}

const normalise = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

export function createBulletsEngine(opts: {
  chat: ChatFn
  searchCalls: SearchCallsFn
  context: () => PreparedContext | null
  onBullets: (all: OleBullet[]) => void
  now?: () => number
  minIntervalMs?: number
  maxLookupsPerMinute?: number
  windowMs?: number
}): BulletsEngine {
  const now = opts.now ?? Date.now
  const minIntervalMs = opts.minIntervalMs ?? 20_000
  const maxLookups = opts.maxLookupsPerMinute ?? 3
  const windowMs = opts.windowMs ?? WINDOW_MS
  const lines: TranscriptLine[] = []
  let list: OleBullet[] = []
  // Live for the whole call: the spec says never the same question twice in one call.
  const searched = new Set<string>()
  let lookups: number[] = []
  let stopped = false, running = false, dirty = false, lastRun = -Infinity, seq = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const schedule = () => {
    if (stopped || running || !dirty || timer) return
    const wait = lastRun + minIntervalMs - now()
    if (wait <= 0) { void run(); return }
    timer = setTimeout(() => { timer = null; schedule() }, wait)
  }

  const lookup = async (call: ToolCall): Promise<string> => {
    if (call.function.name !== 'search_calls') return 'not allowed: unknown tool'
    let query = ''
    try { const args = JSON.parse(call.function.arguments || '{}'); if (typeof args?.query === 'string') query = args.query.trim() } catch { return 'not allowed: invalid arguments' }
    const key = normalise(query)
    if (!key) return 'not allowed: empty query'
    if (searched.has(key)) return 'not allowed: this query was already searched during this call'
    const at = now()
    lookups = lookups.filter(t => at - t < 60_000)
    if (lookups.length >= maxLookups) return 'not allowed: lookup limit reached, answer from what you have'
    searched.add(key)
    lookups.push(at)
    try { return await opts.searchCalls(query) } catch { return 'search failed' }
  }

  const run = async () => {
    running = true; dirty = false; lastRun = now()
    try {
      const messages = buildBulletsPrompt({ context: opts.context(), lines: recentWindow(lines, windowMs), previous: list })
      let reply = await opts.chat({ messages, tools: [SEARCH_CALLS_TOOL], response_format: { type: 'json_object' } })
      for (let round = 1; reply.tool_calls?.length; round++) {
        if (stopped) return
        messages.push({ role: 'assistant', content: reply.content, tool_calls: reply.tool_calls })
        for (const call of reply.tool_calls) messages.push({ role: 'tool', tool_call_id: call.id, content: await lookup(call) })
        // The last round offers no tools, so the model has to answer.
        reply = await opts.chat({ messages, ...(round < TOOL_ROUNDS ? { tools: [SEARCH_CALLS_TOOL] } : {}), response_format: { type: 'json_object' } })
        if (round >= TOOL_ROUNDS) break
      }
      if (stopped) return
      const seen = new Set(list.map(b => normalise(b.text)))
      const fresh: OleBullet[] = []
      for (const b of parseBullets(reply.content)) {
        const key = normalise(b.text)
        if (seen.has(key)) continue
        seen.add(key)
        fresh.push({ id: `b${++seq}`, text: b.text, source: b.source, at: now() })
      }
      if (fresh.length) { list = [...fresh, ...list]; opts.onBullets([...list]) }
    } catch {
      // Swallowed: the panel stays quiet and the next interval tries again.
      dirty = true
    } finally {
      running = false
      schedule()
    }
  }

  return {
    push(line) {
      if (stopped || !line.text.trim()) return
      lines.push(line)
      if (lines.length > 1 && lines[lines.length - 2].startMs > line.startMs) lines.sort((a, b) => a.startMs - b.startMs)
      if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES)
      dirty = true
      schedule()
    },
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
    },
    bullets: () => [...list],
  }
}
