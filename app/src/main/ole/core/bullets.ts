// Ole: live context bullets. Throttled model calls over the recent transcript and the prepared context.
import type { OleBullet, OleTool, PreparedContext } from './types'
import { noteLine } from './meetingSource'
import { toOpenAiTools } from './tools'
import { createBulletStream } from './bulletStream'
import { linkAndLabel, receivedUrls } from './links'
import { anonymiseSourceLink, knownOrganisations, type AnonymityRules } from './anonymise'

export type TranscriptLine = { speaker: string; text: string; startMs: number }
export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } }
export type ChatMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string }
/**
 * onDelta (#84): stream the answer, each content piece as it arrives. A ChatFn may ignore it and answer whole; the
 * reply it resolves with is the whole message either way.
 */
export type ChatFn = (req: { messages: ChatMessage[]; tools?: unknown[]; response_format?: unknown; onDelta?: (text: string) => void }) => Promise<{ content: string | null; tool_calls?: ToolCall[] }>
export type CallToolFn = (name: string, argsJson: string) => Promise<string>
export type BulletsEngine = {
  push(line: TranscriptLine): void; stop(): void; bullets(): OleBullet[]
  /** pin (#54) or rate (#55) a bullet in place; null rating or false pin clears it. null: no such bullet */
  update(id: string, patch: { pinned?: boolean; rating?: 'up' | 'down' | null }): OleBullet | null
  /** the last part of the call, for Ask (#53) */
  recent(): TranscriptLine[]
  /** a bullets turn is running now (#86: background lookups wait for it) */
  busy(): boolean
  /** what this call's lookups returned so far (#109: the enricher tells products from names with it) */
  lookedUp(): string
}
/** what the person rated on earlier calls (#55) */
export type BulletFeedback = { useful: string[]; notUseful: string[] }

const WINDOW_MS = 180_000
const TOOL_ROUNDS = 2
const PREVIOUS_IN_PROMPT = 30
const MAX_LINES = 2000
/** lookup results kept per call (#74); each is already capped by the tool runner */
const MAX_KEPT_RESULTS = 60
export const EARLIER_LOOKUP = '(looked up earlier in this call)'

/** Lines from the last `windowMs` before the newest line. */
export function recentWindow(lines: TranscriptLine[], windowMs = WINDOW_MS): TranscriptLine[] {
  const last = lines.at(-1)
  return last ? lines.filter(l => l.startMs >= last.startMs - windowMs) : []
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** sources follow the bullet text's anonymity rule (#109); Ole also enforces it after the fact (anonymise.ts) */
export const SOURCE_ANONYMITY = 'Sources follow the same rule: a "source" names an organisation only if it is part of this meeting; any other organisation is described by kind and size there too, for example "call records: a large financial services company".'

export const BULLETS_SYSTEM = [
  'You help the user during a live call by surfacing short context bullets they can glance at.',
  'Reply with JSON only: {"bullets":[{"text":"...","source":"...","heard":"...","quote":"..."}]}.',
  '"url": the source\'s web address exactly as it appears in the prepared context or a tool result (an issue, docs page, tracker or record); leave it out when there is none. Never make one up.',
  '"heard": the few words from the conversation this bullet answers, copied exactly (under 12 words). "quote": a short excerpt copied exactly from the prepared context or tool result the fact came from (under 25 words).',
  'Give 0 to 2 NEW bullets. Fewer is better: only what the people on the call do not already know.',
  'Each bullet is a headline the user can read mid-sentence: 10 words at most, the fact first, no advice verbs (assess, consider, relate, connect, note that). Good: "Same 429s at a fintech, fixed in 2.3". Bad: "Consider relating the rate limiting discussion to the earlier fintech case". Detail belongs in heard and quote.',
  'Never restate, summarise or comment on what is being said in the call; the user just heard it. "Transcript" is never a source.',
  'Every bullet must cite the record its fact came from, the way the prepared context or the tool result names it, for example "ticket #4821", "call notes, 12 Nov", "issue #412" or "product docs". Copy the source the prepared context gives for that fact. A section heading of the prepared context (such as "Who" or "Open items"), "prepared context" and a bare tool name are never sources. With no real source, give no bullet. Never invent facts.',
  'Never repeat or rephrase an earlier bullet.',
  'Other organisations and people the tools mention stay anonymous unless they are part of this meeting: describe them by kind and size, for example "a large financial services company".',
  SOURCE_ANONYMITY,
  'Answer from the prepared context first. You may call the provided tools for facts the prepared context lacks, such as how a similar case went elsewhere, or a product or topic with no notes. Lookups are limited, so call a tool only for a real gap.',
  "Never put an organisation's or person's name in a search of public documentation.",
  'When nothing useful applies, reply {"bullets":[]}.',
].join('\n')

/** what a briefing says when nothing in the tools matches the call (#57, #71); prepare.ts writes these lines (older wording kept) */
const NO_RECORD_LINES = [/^no (?:matching record|customer account) for this call\b/i, /^couldn['’]t match this call to a meeting or (?:record|account)\b/i]

/** the heading of a section added to the briefing during the call (#86) */
export const MENTIONED_HEADING = '## Mentioned during the call:'

/** the briefing as Prepare wrote it, without the sections added during the call (#86) */
export function preparedPart(text: string): string {
  const at = text.indexOf(MENTIONED_HEADING)
  return at === -1 ? text : text.slice(0, at)
}

/** the call matched a record: a briefing exists and did not say it found none (#57); sections added mid-call don't count (#86) */
export function hasMatchedRecord(context: PreparedContext | null): boolean {
  const first = preparedPart(context?.text ?? '').trim().split('\n')[0]?.trim() ?? ''
  return !!first && !NO_RECORD_LINES.some(r => r.test(first))
}

export const NO_RECORD_RULE = 'Nothing in the tools matches this call. Give general facts only: documentation, known issues, how something works, and patterns seen across many records, generalised and anonymised (for example "a common pattern among fintech startups"). Never details from one organisation\'s or person\'s records.'
/** on such a call, the sections looked up for names the other side said (#86) may still be used */
export const MENTIONED_RULE = 'Exception: a briefing section headed "Mentioned during the call" was looked up for a name said on this call; its facts may be used, with their sources.'
/**
 * The rule for a call with no matching record. The exception comes only from trusted state: the session says the
 * enricher added sections (#86), never because the briefing's text happens to contain the heading.
 */
export function noRecordRule(mentioned = false): string {
  return mentioned ? `${NO_RECORD_RULE}\n${MENTIONED_RULE}` : NO_RECORD_RULE
}
/** Prepare's output with any text posing as a mid-call section taken out of heading form, before it is stored (#86) */
export function stripMentioned(text: string): string {
  return text.replace(/#+[ \t]*Mentioned during the call:/gi, 'Mentioned during the call:')
}

/**
 * What a source may name during this call (#109, #116): allowed are only the matched record's name(s), and only when
 * the call matched a record (plus `extra`, such as the name a mid-call section was looked up for); the meeting title
 * and focus never allow a name themselves, they only helped Prepare pick the record. known are the organisations
 * Prepare's results named and those in `material` (this turn's results); truncated when Prepare found more than it
 * kept, so sources fail closed.
 */
export function anonymityFor(context: PreparedContext | null, material: string | string[], extra: string[] = []): AnonymityRules {
  const matched = hasMatchedRecord(context)
  const allowed = [...(matched ? context?.records ?? [] : []), ...extra].filter(s => s.trim())
  return { allowed, known: [...(context?.orgs ?? []), ...knownOrganisations(material)], ...(context?.orgsTruncated ? { truncated: true } : {}) }
}

/** tools that fetch one organisation's or person's records (CRM-style names): left out of a call with no matching record (#57) */
const SINGLE_RECORD = /account|opportunit|deal|contact|action_item|interaction|customer|pipeline|poc|tracker|call_brief|transcript|note/i
/** a tool named like a lookup of one organisation's or person's records (#57, #86) */
export const isRecordTool = (t: Pick<OleTool, 'tool'>) => SINGLE_RECORD.test(t.tool)
export function generalTools(tools: OleTool[]): OleTool[] {
  return tools.filter(t => !SINGLE_RECORD.test(t.tool))
}

/** The system and user messages for one bullets turn. */
/** the latest part of the user's notes that goes into a prompt (#77) */
export const NOTES_IN_PROMPT = 1500
/** the latest `max` characters, cut at a line where possible */
export function latestNotes(notes: string, max = NOTES_IN_PROMPT): string {
  const t = notes.trim()
  if (t.length <= max) return t
  const tail = t.slice(-max)
  const nl = tail.indexOf('\n')
  return `…${nl > -1 && nl < max / 3 ? tail.slice(nl + 1) : tail}`
}

/**
 * The system and user messages for one bullets turn. What doesn't change during a call comes first (rules, briefing,
 * past-call feedback) so prompt caching covers it; then what changes: the running summary (#75), the user's notes
 * (#77), earlier bullets and the recent transcript.
 */
export function buildBulletsPrompt(args: { context: PreparedContext | null; lines: TranscriptLine[]; previous: OleBullet[]; feedback?: BulletFeedback; summary?: string; notes?: string
  /** the enricher added sections to the briefing this call (#86); from the session, never from the text */
  mentioned?: boolean }): ChatMessage[] {
  const { context, lines, previous, feedback, summary, notes } = args
  const parts: string[] = []
  if (context?.text) {
    const about = [context.meetingTitle ? `meeting: ${context.meetingTitle}` : null, context.focus ? `focus: ${context.focus}` : null].filter(Boolean).join(', ')
    parts.push(`Prepared context${about ? ` (${about})` : ''}:\n${context.text}`)
  } else parts.push(`No context prepared.${context?.meetingTitle ? ` Meeting: ${context.meetingTitle}` : ''}${context?.focus ? ` Focus: ${context.focus}` : ''}`)
  // a server's one-line note on the meeting (#98): short extra context, capped where it was read
  if (context?.note?.text) parts.push(noteLine(context.note))
  if (!hasMatchedRecord(context)) parts.push(noRecordRule(args.mentioned))
  // the person's thumbs from earlier calls tune what is worth surfacing (#55)
  if (feedback?.useful.length) parts.push(`Bullets the user found useful on earlier calls:\n${feedback.useful.map(t => `- ${t}`).join('\n')}`)
  if (feedback?.notUseful.length) parts.push(`Bullets the user found not useful on earlier calls (give none like these):\n${feedback.notUseful.map(t => `- ${t}`).join('\n')}`)
  if (summary?.trim()) parts.push(`The call so far (summary):\n${summary.trim()}`)
  if (notes?.trim()) parts.push(`The user's notes so far:\n${latestNotes(notes)}`)
  const earlier = previous.slice(0, PREVIOUS_IN_PROMPT)
  const mark = (b: OleBullet) => b.rating === 'down' ? ' (the user marked this not useful)' : b.rating === 'up' ? ' (the user marked this useful)' : ''
  parts.push(earlier.length ? `Earlier bullets (do not repeat):\n${earlier.map(b => `- ${b.text}${mark(b)}`).join('\n')}` : 'Earlier bullets: none')
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
    // "About extProc", "Re: SSO", "Topic: pricing" name a subject, not a record anyone can look up (#119)
    return !rest || headings.has(rest) || /^transcript\b/.test(rest) || /^(get|list|search|find|lookup|read|query|fetch|describe)_[a-z0-9_]+\s*:?\s*$/.test(rest)
      || /^(?:about|re|regarding|topic|subject)\b\s*:?\s*\S/.test(rest)
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

// moved to ./links (#107); re-exported for existing callers
export { sourceLabel, urlSource } from './links'

/** "[get_account_details: Acme]" reads as "account details: Acme" (#48) */
export function readableSource(source: string): string {
  return source.split(/\s*;\s*/).map(p => p.replace(/^\[|\]$/g, '').replace(/^(?:get|list|search|find|lookup|read|query|fetch|describe)_([a-z0-9_]+)\s*:/i, (_m, rest: string) => `${rest.replace(/_/g, ' ')}:`).trim()).filter(Boolean).join('; ')
}

export type ParsedBullet = { text: string; source: string; heard?: string; quote?: string; url?: string }
/** bullets read from one reply at most (whole or streamed) */
const BULLETS_PER_REPLY = 3

/** one element of a reply's "bullets", or null when it lacks text or a source; never throws */
export function parseBulletItem(item: unknown): ParsedBullet | null {
  const o = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
  const text = typeof o.text === 'string' ? o.text.trim() : ''
  const source = typeof o.source === 'string' ? o.source.trim() : ''
  if (!text || !source) return null
  // backstop for a wordy model: a bullet is a headline (#40)
  const short = clip(text.replace(/\s+/g, ' '), BULLET_MAX)
  const heard = typeof o.heard === 'string' ? clip(o.heard.trim().replace(/^["“]|["”]$/g, ''), 100) : ''
  const quote = typeof o.quote === 'string' ? clip(o.quote.trim().replace(/^["“]|["”]$/g, ''), 160) : ''
  const url = typeof o.url === 'string' && /^https:\/\/[^\s"<>]{3,500}$/.test(o.url.trim()) ? o.url.trim() : ''
  return { text: short, source: readableSource(source), ...(heard ? { heard } : {}), ...(quote ? { quote } : {}), ...(url ? { url } : {}) }
}

export function parseBullets(content: string | null): ParsedBullet[] {
  if (!content) return []
  const body = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { return [] }
  const list = (parsed as { bullets?: unknown })?.bullets
  if (!Array.isArray(list)) return []
  const out: ParsedBullet[] = []
  for (const item of list) {
    const b = parseBulletItem(item)
    if (b) out.push(b)
    if (out.length === BULLETS_PER_REPLY) break
  }
  return out
}

const normalise = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

/** words that carry no fact of their own, left out when comparing two bullets (#81) */
const STOP_WORDS = new Set(('a an the and or but nor so of to in on at by for with from into onto over under about as than then '
  + 'is are was were be been being am do does did done has have had having will would can could should may might must shall '
  + 'it its it\'s this that these those there here their they them he she his her we our you your i me my us '
  + 'not no yes also too very just only still already again now same more most less some any all each per via '
  + 'what which who whom whose when where why how if while after before since until up down out off new').split(' '))

/** a word cut to a rough stem, so "fixes", "fixed" and "fixing" compare equal; "429s" becomes "429" */
const stem = (w: string) => {
  if (/^\d[\d.]*s$/.test(w)) return w.slice(0, -1)
  if (/\d/.test(w) || w.length <= 3) return w
  const y = w.replace(/(?:ies|ied)$/, 'y')
  if (y !== w) return y
  const cut = w.replace(/(?:ing|ed|es|s)$/, '')
  const base = cut.length >= 3 ? cut : w
  return base.length > 3 ? base.replace(/e$/, '') : base
}

/** the content words of a bullet (#81): lower case, stop words out, numbers and versions (2.3, 429s) kept */
export function contentWords(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z0-9]+(?:[.'’][a-z0-9]+)*/g) ?? []
  return new Set(words.map(w => w.replace(/[’']s$/, '')).filter(w => !STOP_WORDS.has(w)).map(stem).filter(w => w.length > 1 || /\d/.test(w)))
}

/** numbers, versions and dates: two bullets that differ in one of these state different facts */
const SPECIFIC = /\d|^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/

/** share of the smaller bullet's content words that two bullets must share to count as the same fact (#81) */
export const NEAR_DUPLICATE = 0.6
/** and at least this many shared words, so one shared product name never makes two bullets the same */
const NEAR_DUPLICATE_MIN_SHARED = 2

/**
 * A new bullet that restates an earlier one in other words (#81): most of the smaller one's content words appear in
 * the other. "Fixed in 2.3" and "2.3 fixes the 429s" match; "Fixed in 2.3" and "Fixed in 2.4" do not.
 */
export function nearDuplicate(text: string, earlier: string[], threshold = NEAR_DUPLICATE): boolean {
  const a = contentWords(text)
  if (!a.size) return false
  return earlier.some(e => {
    const b = contentWords(e)
    if (!b.size) return false
    let shared = 0
    for (const w of a) if (b.has(w)) shared++
    if (shared < NEAR_DUPLICATE_MIN_SHARED || shared / Math.min(a.size, b.size) < threshold) return false
    // a number or date each side has and the other lacks is a different fact ("renews 30 June", "renews 30 July")
    const own = (x: Set<string>, y: Set<string>) => [...x].some(w => SPECIFIC.test(w) && !y.has(w))
    return !(own(a, b) && own(b, a))
  })
}

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

/** the shortest gap between turns when the other side asks something or names something new (#79) */
export const FAST_MIN_MS = 10_000

/** a line that opens like a question: an interrogative first word, after an optional filler ("so", "and", "okay") */
const INTERROGATIVE = /^(?:(?:so|and|but|ok|okay|um|uh|well|right|also)[,\s]+)?(?:what|how|why|when|where|who|which|can|could|does|do|is|are|will|would|should)\b/i
/** a capitalised word that names nothing: pronoun contractions, greetings, fillers, days and months */
const PLAIN_CAPITALISED = new Set(('i i\'m i\'ll i\'ve i\'d ok okay yeah yes no hello hi hey thanks thank sorry please sure right well so '
  + 'monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december '
  + 'english mr mrs ms dr god').split(' '))
/** a number that is not a term: 3rd, 10am, 30s, 5k, 20% */
const PLAIN_NUMBER = /^\d+(?:st|nd|rd|th|s|am|pm|k|m|x|%)?$/i

/** the words of a text as the trigger compares them: lower case, punctuation at the ends dropped */
export function knownWords(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9][a-z0-9.+#_/-]*[a-z0-9+#]|[a-z0-9]/g) ?? [])
}

/** a line that asks something: ends with a question mark or opens with an interrogative (#79) */
export function isQuestion(text: string): boolean {
  const t = text.trim()
  return t.endsWith('?') || INTERROGATIVE.test(t)
}

/**
 * Terms in a line that look like a product, feature, version, person or organisation (#79): CamelCase (OpenShift,
 * eBPF), letters with digits or a version (S3, K8s, 2.3), ALLCAPS of 2+ letters (SSO, APIs), or a capitalised word
 * that doesn't start a sentence. In the order they appear.
 */
export function candidateTerms(text: string): string[] {
  const out: string[] = []
  const tokens = text.split(/\s+/)
  tokens.forEach((raw, i) => {
    const tok = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9+#]+$/g, '').replace(/[’']s$/, '')
    if (!tok) return
    const startsSentence = i === 0 || /[.!?:]["')\]]*$/.test(tokens[i - 1])
    const code = /\d/.test(tok) && !PLAIN_NUMBER.test(tok) && (/\d\.\d/.test(tok) || /[a-z]/i.test(tok))
    const caps = /^[A-Z]{2,}\d*s?$/.test(tok) && !PLAIN_CAPITALISED.has(tok.toLowerCase())
    const camel = /^[A-Za-z]*[a-z][A-Z][A-Za-z0-9]*$/.test(tok)
    const capitalised = !startsSentence && /^[A-Z][a-z]{2,}$/.test(tok) && !PLAIN_CAPITALISED.has(tok.toLowerCase())
    if (code || caps || camel || capitalised) out.push(tok)
  })
  return out
}

/** a capitalised word that can be part of a name: Acme, O'Neil, Smith-Jones; not CamelCase, ALLCAPS or digits */
const NAME_WORD = /^[A-Z][a-z]+(?:['’-][A-Z]?[a-z]+)*$/
/** words in a name looked up during the call (#86) */
const NAME_WORDS_MAX = 4

/**
 * Names in a line (#86): a capitalised word that doesn't start a sentence, with the capitalised words straight after
 * it ("Northwind Traders", "Dana Whitfield"), as #79's trigger finds them. Product and version tokens (CamelCase,
 * ALLCAPS, anything with a digit) are never names. Punctuation after a word ends the name. In the order they appear.
 */
export function nameTerms(text: string): string[] {
  const out: string[] = []
  let run: string[] = []
  const flush = () => { if (run.length) out.push(run.join(' ')); run = [] }
  const tokens = text.split(/\s+/)
  tokens.forEach((raw, i) => {
    const tok = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9+#]+$/g, '').replace(/[’']s$/, '')
    const startsSentence = i === 0 || /[.!?:]["')\]]*$/.test(tokens[i - 1])
    const name = tok.length >= 3 && NAME_WORD.test(tok) && !PLAIN_CAPITALISED.has(tok.toLowerCase())
    if (name && (run.length || !startsSentence) && run.length < NAME_WORDS_MAX) run.push(tok)
    else { flush(); if (name && !startsSentence) run.push(tok) }
    if (/[^A-Za-z0-9'’]$/.test(raw)) flush()
  })
  flush()
  return out
}

/**
 * Whether a line from the other side should bring the next bullets turn forward (#79): a question, or a term the
 * briefing and the bullets so far never mention and that hasn't already done so. Pure string work, no model call.
 */
export function fastTrigger(text: string, known: Set<string>, already: Set<string> = new Set()): { kind: 'question' } | { kind: 'term'; term: string } | null {
  if (isQuestion(text)) return { kind: 'question' }
  for (const term of candidateTerms(text)) {
    const key = term.toLowerCase()
    if (!known.has(key) && !already.has(key)) return { kind: 'term', term: key }
  }
  return null
}

/** the user's own track: only the other side's lines bring a turn forward (#79) */
const isOwnLine = (speaker: string) => speaker.trim().toLowerCase() === 'me'

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
  /** the running summary of the call (#75) and the user's notes (#77), read at each turn */
  summary?: () => string
  notes?: () => string
  /** the enricher added sections to the briefing (#86), from the session's own state */
  mentioned?: () => boolean
  /** one line per turn, counts only, never transcript or bullet text (#59) */
  log?: (line: string) => void
  now?: () => number
  /** the timer the throttle waits on; the replay harness (#66) passes a virtual one so a call replays at its own pace */
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void }
  minIntervalMs?: number
  /** the shorter gap after a question or a new term from the other side (#79); 0 turns fast turns off */
  fastMinMs?: number
  maxLookupsPerMinute?: number
  windowMs?: number
}): BulletsEngine {
  const now = opts.now ?? Date.now
  const timers = opts.timers ?? { set: (fn: () => void, ms: number): unknown => setTimeout(fn, ms), clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) }
  const log = opts.log ?? ((line: string) => console.info(line))
  // about every 45 s of new conversation: enough to keep up, few enough to read (#38)
  const minIntervalMs = opts.minIntervalMs ?? 45_000
  const maxLookups = opts.maxLookupsPerMinute ?? 3
  const windowMs = opts.windowMs ?? WINDOW_MS
  const lines: TranscriptLine[] = []
  let list: OleBullet[] = []
  // Live for the whole call: the same lookup never reaches the server twice; a repeat gets the kept result (#74).
  const results = new Map<string, string>()
  let lookups: number[] = []
  let stopped = false, running = false, dirty = false, lastRun = -Infinity, seq = 0
  let timer: unknown = null
  // a question or a new term from the other side brings the next turn forward to fastMinMs (#79), never slower
  const fastMinMs = Math.min(Math.max(0, opts.fastMinMs ?? FAST_MIN_MS), minIntervalMs)
  let urgent = false
  /** terms that already brought a turn forward: each does so once per call */
  const triggered = new Set<string>()
  let knownFor: { text: string; list: OleBullet[]; words: Set<string> } | null = null
  /** the briefing's and the bullets' words, worked out again only when either changes */
  const known = () => {
    const text = opts.context()?.text ?? ''
    if (!knownFor || knownFor.text !== text || knownFor.list !== list) knownFor = { text, list, words: knownWords(`${text}\n${list.map(b => b.text).join('\n')}`) }
    return knownFor.words
  }

  const schedule = () => {
    if (stopped || running || !dirty || timer !== null) return
    const wait = lastRun + (urgent && fastMinMs > 0 ? fastMinMs : minIntervalMs) - now()
    if (wait <= 0) { void run(); return }
    timer = timers.set(() => { timer = null; schedule() }, wait)
  }

  // Lookups asked in the same round, still waiting for the server: an identical one shares the request (#80).
  const inflight = new Map<string, Promise<string>>()
  /**
   * Everything up to the server request runs synchronously, so a round's lookups started together (#80) still take
   * the per-minute slots in order and an identical call in the same round never reaches the server twice.
   */
  const lookup = (call: ToolCall, allowed: Set<string>): Promise<string> => {
    const name = call.function.name
    if (!allowed.has(name)) return Promise.resolve('not allowed: unknown tool')
    let args: unknown
    try { args = call.function.arguments?.trim() ? JSON.parse(call.function.arguments) : {} } catch { return Promise.resolve('not allowed: invalid arguments') }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return Promise.resolve('not allowed: invalid arguments')
    const key = callKey(name, args)
    const kept = results.get(key)
    if (kept !== undefined) return Promise.resolve(`${EARLIER_LOOKUP}\n${kept}`)
    const pending = inflight.get(key)
    if (pending) return pending.then(r => `${EARLIER_LOOKUP}\n${r}`)
    const at = now()
    lookups = lookups.filter(t => at - t < 60_000)
    if (lookups.length >= maxLookups) return Promise.resolve('not allowed: lookup limit reached, answer from what you have')
    lookups.push(at)
    let request: Promise<string>
    try { request = Promise.resolve(opts.callTool(name, JSON.stringify(args))) } catch (e) { request = Promise.reject(e) }
    const done = request.catch(() => 'lookup failed').then(result => {
      inflight.delete(key)
      if (results.size >= MAX_KEPT_RESULTS) results.delete(results.keys().next().value!)
      results.set(key, result)
      return result
    })
    inflight.set(key, done)
    return done
  }

  const run = async () => {
    // fast: brought forward by a trigger, earlier than the usual rhythm would have run it (#79)
    const fast = urgent && now() - lastRun < minIntervalMs
    running = true; dirty = false; urgent = false; lastRun = now()
    try {
      const messages = buildBulletsPrompt({ context: opts.context(), lines: recentWindow(lines, windowMs), previous: list, feedback: opts.feedback?.(), summary: opts.summary?.(), notes: opts.notes?.(), mentioned: opts.mentioned?.() })
      const offered = opts.tools()
      const allowed = new Set(offered.map(t => t.name))
      const tools = offered.length ? { tools: toOpenAiTools(offered) } : {}
      const seen = new Set(list.map(b => normalise(b.text)))
      const shownTexts = list.map(b => b.text)
      const fresh: OleBullet[] = []
      let dropped = 0, repeated = 0, shownCount = 0
      /** the bullets taken from the stream this turn, as parsed (#84) */
      const streamed: string[] = []
      /** each bullet gets exactly the same checks, streamed or not */
      const consider = (b: ParsedBullet) => {
        // a briefing heading isn't a source you can check (#37)
        if (onlyHeadings(b.source, briefingHeadings(opts.context()?.text ?? ''))) { dropped++; return }
        const key = normalise(b.text)
        // the same words, or the same fact in other words, as a bullet already shown or earlier in this turn (#81)
        if (seen.has(key) || nearDuplicate(b.text, shownTexts)) { repeated++; return }
        seen.add(key)
        shownTexts.push(b.text)
        // the excerpts are checked against what Ole actually has; one that doesn't match is left out, never shown (#39)
        const sources = `${opts.context()?.text ?? ''}\n${messages.filter(m => m.role === 'tool').map(m => m.content ?? '').join('\n')}`
        const spoken = recentWindow(lines, windowMs).map(l => l.text).join(' ')
        const heard = b.heard && overlap(b.heard, spoken) >= EXCERPT_MATCH ? b.heard : undefined
        const quote = b.quote && overlap(b.quote, sources) >= EXCERPT_MATCH ? b.quote : undefined
        // a link is kept only if Ole received that exact address: models invent plausible URLs (#42, #107); a source
        // that is a bare web address becomes a short label taken from the link actually used (#102, #107)
        const linked = linkAndLabel(b.url, b.source, receivedUrls(sources))
        // the source names no organisation but the meeting's own (#109)
        const looked = messages.filter(m => m.role === 'tool').map(m => m.content ?? '')
        const shown = anonymiseSourceLink(linked.source ?? b.source, linked.url, anonymityFor(opts.context(), [opts.context()?.text ?? '', ...looked]))
        const url = shown.url
        const source = shown.source
        fresh.push({ id: `b${++seq}`, text: b.text, source, at: now(), ...(heard ? { heard } : {}), ...(quote ? { quote } : {}), ...(url ? { url } : {}) })
      }
      /** this turn's bullets on top, in the model's order; a pin or rating made meanwhile is kept */
      const show = () => {
        const ids = new Set(fresh.map(b => b.id))
        list = [...fresh, ...list.filter(b => !ids.has(b.id))]
        shownCount = fresh.length
        opts.onBullets([...list])
      }
      /** a model request whose answer streams (#84): each complete bullet is checked and shown as it arrives */
      const ask = (req: Parameters<ChatFn>[0]) => {
        let taken = 0
        const reader = createBulletStream(item => {
          if (stopped || taken >= BULLETS_PER_REPLY) return
          const b = parseBulletItem(item)
          if (!b) return
          taken++
          streamed.push(JSON.stringify(b))
          consider(b)
          if (fresh.length > shownCount) show()
        })
        return opts.chat({ ...req, onDelta: text => reader.push(text) })
      }
      let reply = await ask({ messages, ...tools, response_format: { type: 'json_object' } })
      for (let round = 1; reply.tool_calls?.length; round++) {
        if (stopped) return
        messages.push({ role: 'assistant', content: reply.content, tool_calls: reply.tool_calls })
        // a round's lookups are independent: they run together, answered in the order they were asked (#80)
        const calls = reply.tool_calls
        const answered = await Promise.all(calls.map(call => lookup(call, allowed)))
        calls.forEach((call, i) => messages.push({ role: 'tool', tool_call_id: call.id, content: answered[i] }))
        // The last round offers no tools, so the model has to answer.
        reply = await ask({ messages, ...(round < TOOL_ROUNDS ? tools : {}), response_format: { type: 'json_object' } })
        if (round >= TOOL_ROUNDS) break
      }
      if (stopped) return
      // what is left of the reply: the whole-reply parse is the authority (#84); a bullet already taken from the
      // stream is not taken again, and one the stream gave that the whole reply lacks still counts as back
      const back = parseBullets(reply.content)
      const left = [...streamed]
      for (const b of back) {
        const i = left.indexOf(JSON.stringify(b))
        if (i > -1) left.splice(i, 1)
        else consider(b)
      }
      // never silent (#48, #59): every turn says what happened to its bullets
      const lookupsMade = messages.filter(m => m.role === 'tool').length
      log(`ole bullets: ${back.length + left.length} back, ${fresh.length} shown, ${dropped} without a source, ${repeated} repeated, ${lookupsMade} lookups${fast ? ', fast' : ''}`)
      if (fresh.length > shownCount) show()
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
      if (fastMinMs > 0 && !urgent && !isOwnLine(line.speaker)) {
        const hit = fastTrigger(line.text, known(), triggered)
        if (hit) {
          urgent = true
          if (hit.kind === 'term') triggered.add(hit.term)
          // a turn already waiting for the usual rhythm is brought forward
          if (timer !== null) { timers.clear(timer); timer = null }
        }
      }
      schedule()
    },
    stop() {
      stopped = true
      if (timer !== null) timers.clear(timer)
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
    busy: () => running,
    lookedUp: () => [...results.values()].join('\n'),
  }
}
