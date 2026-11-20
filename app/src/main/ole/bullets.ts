// Ole: live context bullets. Throttled model calls over the recent transcript and the prepared context.
import type { OleBullet, OleTool, PreparedContext } from './types'
import { toOpenAiTools } from './tools'

export type TranscriptLine = { speaker: string; text: string; startMs: number }
export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } }
export type ChatMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string }
export type ChatFn = (req: { messages: ChatMessage[]; tools?: unknown[]; response_format?: unknown }) => Promise<{ content: string | null; tool_calls?: ToolCall[] }>
export type CallToolFn = (name: string, argsJson: string) => Promise<string>
export type BulletsEngine = {
  push(line: TranscriptLine): void; stop(): void; bullets(): OleBullet[]
  /** pin (#54) or rate (#55) a bullet in place; null rating or false pin clears it. null: no such bullet */
  update(id: string, patch: { pinned?: boolean; rating?: 'up' | 'down' | null }): OleBullet | null
  /** the last part of the call, for Ask (#53) */
  recent(): TranscriptLine[]
}
/** what the person rated on earlier calls (#55) */
export type BulletFeedback = { useful: string[]; notUseful: string[] }

const WINDOW_MS = 180_000
const TOOL_ROUNDS = 2
const PREVIOUS_IN_PROMPT = 30
const MAX_LINES = 2000

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
  'You help a sales engineer during a live customer call by surfacing short context bullets they can glance at.',
  'Reply with JSON only: {"bullets":[{"text":"...","source":"...","heard":"...","quote":"..."}]}.',
  '"url": the source\'s web address exactly as it appears in the prepared context or a tool result (an issue, docs page, tracker or record); leave it out when there is none. Never make one up.',
  '"heard": the few words from the conversation this bullet answers, copied exactly (under 12 words). "quote": a short excerpt copied exactly from the prepared context or tool result the fact came from (under 25 words).',
  'Give 0 to 2 NEW bullets. Fewer is better: only what the people on the call do not already know.',
  'Each bullet is a headline the user can read mid-sentence: 10 words at most, the fact first, no advice verbs (assess, consider, relate, connect, note that). Good: "Same 429s at a fintech, fixed in 2.3". Bad: "Consider relating the rate limiting discussion to the earlier fintech case". Detail belongs in heard and quote.',
  'Never restate, summarise or comment on what is being said in the call; the user just heard it. "Transcript" is never a source.',
  'Every bullet must cite the record its fact came from, the way the prepared context or the tool result names it, for example "opportunity: Platform expansion", "call brief, 12 Nov", "issue #412" or "product docs". Copy the source the prepared context gives for that fact. A section heading of the prepared context (such as "Deals" or "Who and why"), "prepared context" and a bare tool name are never sources. With no real source, give no bullet. Never invent facts.',
  'Never repeat or rephrase an earlier bullet.',
  'Anonymise other customers by industry and size, for example "a large financial services customer". Never name another customer; only the current account may be named.',
  'Answer from the prepared context first. You may call the provided tools for facts the prepared context lacks, such as another customer\'s experience or a competitor with no notes. Lookups are limited, so call a tool only for a real gap.',
  'When nothing useful applies, reply {"bullets":[]}.',
].join('\n')

/** what a briefing says when the call has no customer account (#57); prepare.ts writes these lines */
const NO_ACCOUNT_LINES = [/^no customer account for this call\b/i, /^couldn['’]t match this call to a meeting or account\b/i]

/** the call has a customer account: a briefing exists and did not say it found none (#57) */
export function hasCustomerAccount(context: PreparedContext | null): boolean {
  const first = context?.text?.trim().split('\n')[0]?.trim() ?? ''
  return !!first && !NO_ACCOUNT_LINES.some(r => r.test(first))
}

export const NO_ACCOUNT_RULE = 'This call has no customer account. Give general facts only: product docs, known issues, how a feature works, and patterns seen across customers, generalised and anonymised (for example "a common pattern among fintech startups"). Never one customer\'s account, deal, opportunity, contact or action-item details.'

/** tools that fetch a customer's records: left out of a call with no customer account (#57) */
const CUSTOMER_RECORD = /account|opportunit|deal|contact|action_item|interaction|customer|pipeline|poc|tracker|call_brief|transcript|note/i
export function generalTools(tools: OleTool[]): OleTool[] {
  return tools.filter(t => !CUSTOMER_RECORD.test(t.tool))
}

/** The system and user messages for one bullets turn. */
export function buildBulletsPrompt(args: { context: PreparedContext | null; lines: TranscriptLine[]; previous: OleBullet[]; feedback?: BulletFeedback }): ChatMessage[] {
  const { context, lines, previous, feedback } = args
  const parts: string[] = []
  if (context?.text) {
    const about = [context.meetingTitle ? `meeting: ${context.meetingTitle}` : null, context.focus ? `focus: ${context.focus}` : null].filter(Boolean).join(', ')
    parts.push(`Prepared context${about ? ` (${about})` : ''}:\n${context.text}`)
  } else parts.push(`No context prepared.${context?.meetingTitle ? ` Meeting: ${context.meetingTitle}` : ''}${context?.focus ? ` Focus: ${context.focus}` : ''}`)
  if (!hasCustomerAccount(context)) parts.push(NO_ACCOUNT_RULE)
  const earlier = previous.slice(0, PREVIOUS_IN_PROMPT)
  const mark = (b: OleBullet) => b.rating === 'down' ? ' (the user marked this not useful)' : b.rating === 'up' ? ' (the user marked this useful)' : ''
  parts.push(earlier.length ? `Earlier bullets (do not repeat):\n${earlier.map(b => `- ${b.text}${mark(b)}`).join('\n')}` : 'Earlier bullets: none')
  // the person's thumbs from earlier calls tune what is worth surfacing (#55)
  if (feedback?.useful.length) parts.push(`Bullets the user found useful on earlier calls:\n${feedback.useful.map(t => `- ${t}`).join('\n')}`)
  if (feedback?.notUseful.length) parts.push(`Bullets the user found not useful on earlier calls (give none like these):\n${feedback.notUseful.map(t => `- ${t}`).join('\n')}`)
  parts.push(`Transcript (last few minutes):\n${lines.map(l => `[${clock(l.startMs)}] ${l.speaker}: ${l.text}`).join('\n')}`)
  return [{ role: 'system', content: BULLETS_SYSTEM }, { role: 'user', content: parts.join('\n\n') }]
}

/** Bullets with both text and source from a model reply; anything malformed is dropped, never thrown. */
/** the section headings of a briefing (markdown headings, and short lines ending in a colon), lower-cased */
export function briefingHeadings(text: string): Set<string> {
  const out = new Set<string>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const h = line.match(/^#{1,6}\s+(.+?)\s*:?$/) ?? line.match(/^\*\*(.+?)\*\*:?$/) ?? (line.length <= 40 && /:$/.test(line) ? [line, line.slice(0, -1)] : null)
    if (h) out.add(h[1].replace(/[*_`]/g, '').trim().toLowerCase())
  }
  return out
}

/**
 * A source a person couldn't look up (#37): empty, or made only of briefing headings, "transcript", "prepared context"
 * (with or without a heading after it) or bare tool names like "[get_account_health: X]".
 */
export function onlyHeadings(source: string, headings: Set<string>): boolean {
  const parts = source.split(/[;,·]/).map(p => p.replace(/[[\]()]/g, '').trim().toLowerCase()).filter(Boolean)
  const vague = (p: string) => {
    const rest = p.replace(/^prepared context\s*(?:[-—:–]\s*)?/, '').trim()
    // a bare tool name says nothing; "get_account_details: Acme" names a record, so it's a real source (#48)
    return !rest || headings.has(rest) || /^transcript\b/.test(rest) || /^(get|list|search|find|lookup|read|query|fetch|describe)_[a-z0-9_]+\s*:?\s*$/.test(rest)
  }
  return !parts.length || parts.every(vague)
}

/** words of a span that also appear in the material; 0..1, so a quote can be checked loosely against what Ole has (#39) */
export function overlap(span: string, material: string): number {
  const words = span.toLowerCase().match(/[a-z0-9#$%.]{3,}/g) ?? []
  if (!words.length) return 0
  const have = material.toLowerCase()
  return words.filter(w => have.includes(w)).length / words.length
}

/** share of an excerpt's words that must appear in what Ole has for it to be shown */
export const EXCERPT_MATCH = 0.7
/** a bullet longer than this is cut at a word, with an ellipsis */
export const BULLET_MAX = 90

const clip = (s: string, n: number) => {
  if (s.length <= n) return s
  const cut = s.slice(0, n - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > n * 0.6 ? cut.slice(0, space) : cut).replace(/[;,:\s]+$/, '')}…`
}

/** "[get_account_details: Acme]" reads as "account details: Acme" (#48) */
export function readableSource(source: string): string {
  return source.split(/\s*;\s*/).map(p => p.replace(/^\[|\]$/g, '').replace(/^(?:get|list|search|find|lookup|read|query|fetch|describe)_([a-z0-9_]+)\s*:/i, (_m, rest: string) => `${rest.replace(/_/g, ' ')}:`).trim()).filter(Boolean).join('; ')
}

export function parseBullets(content: string | null): Array<{ text: string; source: string; heard?: string; quote?: string; url?: string }> {
  if (!content) return []
  const body = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { return [] }
  const list = (parsed as { bullets?: unknown })?.bullets
  if (!Array.isArray(list)) return []
  const out: Array<{ text: string; source: string; heard?: string; quote?: string; url?: string }> = []
  for (const item of list) {
    const text = typeof item?.text === 'string' ? item.text.trim() : ''
    const source = typeof item?.source === 'string' ? item.source.trim() : ''
    // backstop for a wordy model: a bullet is a headline (#40)
    const short = clip(text.replace(/\s+/g, ' '), BULLET_MAX)
    const heard = typeof item?.heard === 'string' ? clip(item.heard.trim().replace(/^["“]|["”]$/g, ''), 100) : ''
    const quote = typeof item?.quote === 'string' ? clip(item.quote.trim().replace(/^["“]|["”]$/g, ''), 160) : ''
    const url = typeof item?.url === 'string' && /^https:\/\/[^\s"<>]{3,500}$/.test(item.url.trim()) ? item.url.trim() : ''
    if (text && source) out.push({ text: short, source: readableSource(source), ...(heard ? { heard } : {}), ...(quote ? { quote } : {}), ...(url ? { url } : {}) })
    if (out.length === 3) break
  }
  return out
}

const normalise = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

/** same tool, same arguments: key order, case and spacing in string values do not matter */
function canonical(v: unknown): unknown {
  if (typeof v === 'string') return normalise(v)
  if (Array.isArray(v)) return v.map(canonical)
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical((v as Record<string, unknown>)[k])]))
  return v
}
export function callKey(name: string, args: unknown): string {
  return `${name} ${JSON.stringify(canonical(args))}`
}

/** the pinned bullets as a notes section, so the summary and the notes keep them (#54); '' when none */
export function pinnedNotes(bullets: OleBullet[]): string {
  const pinned = bullets.filter(b => b.pinned).sort((a, b) => a.at - b.at)
  if (!pinned.length) return ''
  const src = (b: OleBullet) => b.url ? `[${b.source}](${b.url})` : b.source
  return `## Pinned from the call\n${pinned.map(b => `- ${b.text} (${src(b)})`).join('\n')}`
}

export function createBulletsEngine(opts: {
  chat: ChatFn
  tools: () => OleTool[]
  callTool: CallToolFn
  context: () => PreparedContext | null
  onBullets: (all: OleBullet[]) => void
  feedback?: () => BulletFeedback
  /** one line per turn, counts only, never transcript or bullet text (#59) */
  log?: (line: string) => void
  now?: () => number
  minIntervalMs?: number
  maxLookupsPerMinute?: number
  windowMs?: number
}): BulletsEngine {
  const now = opts.now ?? Date.now
  const log = opts.log ?? ((line: string) => console.info(line))
  // about every 45 s of new conversation: enough to keep up, few enough to read (#38)
  const minIntervalMs = opts.minIntervalMs ?? 45_000
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

  const lookup = async (call: ToolCall, allowed: Set<string>): Promise<string> => {
    const name = call.function.name
    if (!allowed.has(name)) return 'not allowed: unknown tool'
    let args: unknown
    try { args = call.function.arguments?.trim() ? JSON.parse(call.function.arguments) : {} } catch { return 'not allowed: invalid arguments' }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return 'not allowed: invalid arguments'
    const key = callKey(name, args)
    if (searched.has(key)) return 'not allowed: this lookup was already made during this call'
    const at = now()
    lookups = lookups.filter(t => at - t < 60_000)
    if (lookups.length >= maxLookups) return 'not allowed: lookup limit reached, answer from what you have'
    searched.add(key)
    lookups.push(at)
    try { return await opts.callTool(name, JSON.stringify(args)) } catch { return 'lookup failed' }
  }

  const run = async () => {
    running = true; dirty = false; lastRun = now()
    try {
      const messages = buildBulletsPrompt({ context: opts.context(), lines: recentWindow(lines, windowMs), previous: list, feedback: opts.feedback?.() })
      const offered = opts.tools()
      const allowed = new Set(offered.map(t => t.name))
      const tools = offered.length ? { tools: toOpenAiTools(offered) } : {}
      let reply = await opts.chat({ messages, ...tools, response_format: { type: 'json_object' } })
      for (let round = 1; reply.tool_calls?.length; round++) {
        if (stopped) return
        messages.push({ role: 'assistant', content: reply.content, tool_calls: reply.tool_calls })
        for (const call of reply.tool_calls) messages.push({ role: 'tool', tool_call_id: call.id, content: await lookup(call, allowed) })
        // The last round offers no tools, so the model has to answer.
        reply = await opts.chat({ messages, ...(round < TOOL_ROUNDS ? tools : {}), response_format: { type: 'json_object' } })
        if (round >= TOOL_ROUNDS) break
      }
      if (stopped) return
      const seen = new Set(list.map(b => normalise(b.text)))
      const fresh: OleBullet[] = []
      const headings = briefingHeadings(opts.context()?.text ?? '')
      let dropped = 0, repeated = 0
      const back = parseBullets(reply.content)
      for (const b of back) {
        // a briefing heading isn't a source you can check (#37)
        if (onlyHeadings(b.source, headings)) { dropped++; continue }
        const key = normalise(b.text)
        if (seen.has(key)) { repeated++; continue }
        seen.add(key)
        // the excerpts are checked against what Ole actually has; one that doesn't match is left out, never shown (#39)
        const sources = `${opts.context()?.text ?? ''}\n${messages.filter(m => m.role === 'tool').map(m => m.content ?? '').join('\n')}`
        const spoken = recentWindow(lines, windowMs).map(l => l.text).join(' ')
        const heard = b.heard && overlap(b.heard, spoken) >= EXCERPT_MATCH ? b.heard : undefined
        const quote = b.quote && overlap(b.quote, sources) >= EXCERPT_MATCH ? b.quote : undefined
        // a link is kept only if Ole has it: models invent plausible URLs (#42)
        const url = b.url && sources.includes(b.url) ? b.url : undefined
        fresh.push({ id: `b${++seq}`, text: b.text, source: b.source, at: now(), ...(heard ? { heard } : {}), ...(quote ? { quote } : {}), ...(url ? { url } : {}) })
      }
      // never silent (#48, #59): every turn says what happened to its bullets
      const lookupsMade = messages.filter(m => m.role === 'tool').length
      log(`ole bullets: ${back.length} back, ${fresh.length} shown, ${dropped} without a source, ${repeated} repeated, ${lookupsMade} lookups`)
      if (fresh.length) { list = [...fresh, ...list]; opts.onBullets([...list]) }
    } catch (e) {
      // the panel stays quiet and the next interval tries again; the log says why (#59)
      log(`ole bullets: turn failed: ${e instanceof Error ? e.message.slice(0, 200) : 'unknown error'}`)
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
    update(id, patch) {
      const at = list.findIndex(b => b.id === id)
      if (at === -1) return null
      const next: OleBullet = { ...list[at] }
      if ('pinned' in patch) { if (patch.pinned) next.pinned = true; else delete next.pinned }
      if ('rating' in patch) { if (patch.rating === 'up' || patch.rating === 'down') next.rating = patch.rating; else delete next.rating }
      list = list.map((b, i) => i === at ? next : b)
      opts.onBullets([...list])
      return next
    },
    recent: () => recentWindow(lines, windowMs),
  }
}
