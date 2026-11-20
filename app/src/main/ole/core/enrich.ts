// Ole: names said during the call that the briefing doesn't cover (#86). An organization, person or project the
// conversation names is looked up once in the background with the servers' read-only tools, and what they know is
// added to the briefing as a short sourced section, so the bullets, Ask, the panel and the saved briefing have it for
// the rest of the call. Never blocks a bullets turn: one lookup at a time, started only while no turn is running.
import type { OleTool, PreparedContext } from './types'
import { isLiveTool, toOpenAiTools } from './tools'
import { anonymityFor, callKey, EXCERPT_MATCH, isRecordTool, knownWords, MENTIONED_HEADING, nameTerms, onlyHeadings, overlap, readableSource, type CallToolFn, type ChatFn, type ChatMessage, type TranscriptLine } from './bullets'
import { classifyFailure } from './replayFormat'
import { keepLink, receivedUrls } from './links'
import { anonymizeSourceLink } from './anonymize'

/** names looked up per call */
export const ENRICH_MAX_TERMS = 6
/** lookups one name may make, and rounds of them before the model must answer */
export const ENRICH_LOOKUPS = 3
const ENRICH_ROUNDS = 2
/** the shortest time from the start of one name's lookup to the next */
export const ENRICH_GAP_MS = 30_000
/** how long to wait before trying again while a bullets turn or a briefing is running */
export const ENRICH_RETRY_MS = 2_000
/** facts in a section */
export const FACTS_MAX = 3
const FACT_MAX = 160

export const ENRICH_SYSTEM = [
  'During a live call, someone named an organization, person or project that the user\'s briefing does not cover. Find what the tools know about it.',
  'Use the tools to look the name up in the user\'s own records.',
  "Never put an organization's or person's name in a search of public documentation.",
  'Reply with JSON only: {"facts":[{"text":"...","source":"...","quote":"...","url":"..."}]}.',
  `At most ${FACTS_MAX} facts, each one short line about this name, the fact first. "source": the record it came from, named the way the tool result names it. "quote": a short excerpt copied exactly from that tool result (under 25 words). "url": its web address exactly as the tool result gives it; leave it out when there is none.`,
  'Sources follow the same anonymity rule as the bullet text: a "source" may name the organization being looked up or one that is part of this meeting; any other organization is described by kind and size, for example "call records: a large financial services company".',
  'Only facts the tool results state about this name. If the tools find nothing about it, or it is a product, a place or a common word rather than an organization, person or project, reply {"facts":[]}. Never invent facts.',
].join('\n')

/** a name or description that suggests the tool reaches the internet or searches documentation */
export const OUTWARD = /web|internet|http|url|fetch|browse|google|bing|brave|tavily|perplexity|doc|librar|readme|manual|wiki|page/i
const OUTWARD_DESCRIPTION = /\b(?:web|internet|online|documentation|docs)\b/i

/**
 * Whether a name may go to this tool (#86, #91). An allowlist where the server's hint is necessary, never sufficient:
 * a tool marked open-world never gets a name; every tool must pass the local checks (nothing in its name, its
 * description or its server's name suggests the web or a documentation search); then it needs the closed-world hint
 * (openWorldHint false) or a record-lookup name (#57). Unknown kinds get nothing.
 */
export function mayGetNames(t: Pick<OleTool, 'tool' | 'description' | 'openWorld'> & { serverName?: string }): boolean {
  if (t.openWorld === true) return false
  if (OUTWARD.test(t.tool) || OUTWARD_DESCRIPTION.test(t.description) || OUTWARD_DESCRIPTION.test(t.serverName ?? '')) return false
  return t.openWorld === false || isRecordTool(t)
}

/** the tools a name may be looked up with: lookup-style (#15) and allowed to get names */
export function enrichTools(tools: OleTool[]): OleTool[] {
  return tools.filter(t => isLiveTool(t) && mayGetNames(t))
}

/**
 * One line of plain text: no line breaks, no markdown at its start, no headings, bold, links, images or bare URLs of
 * its own. A link reaches the section only through a fact's url, checked against this lookup's results.
 */
const flat = (s: string, max: number) => {
  const one = s.replace(/\s+/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\]\s*\(/g, ' ')
    .replace(/\b(?:https?|ftp|file|data|javascript|vbscript):\S*/gi, '')
    .replace(/[[\]<>]/g, '').replace(/\(\s*\)/g, '')
    .replace(/\*\*|`+/g, '')
    .replace(/\s+/g, ' ').trim()
  let out = one
  for (;;) { const next = out.replace(/^(?:#+|>+|[-*+](?=\s|$)|\d+[.)](?=\s|$))\s*/, '').trim(); if (next === out) break; out = next }
  return out.length <= max ? out : `${out.slice(0, max - 1).trimEnd()}…`
}

/** the section a name's facts become, or '' when there are none */
export function mentionedSection(term: string, facts: Array<{ text: string; source: string; url?: string }>): string {
  if (!facts.length) return ''
  const src = (f: { source: string; url?: string }) => f.url ? `[${flat(f.source, 80)}](${f.url})` : flat(f.source, 80)
  return `${MENTIONED_HEADING} ${flat(term, 60)}\n${facts.slice(0, FACTS_MAX).map(f => `- ${flat(f.text, FACT_MAX)} (${src(f)})`).join('\n')}`
}

/** a lookup result that holds nothing: refused, failed or empty */
const EMPTY_RESULT = /^(?:not allowed:|lookup failed|error:|\(empty result\)|no result|\[\]|\{\}|null)\s*$|^(?:not allowed:|error:)/i

/** the facts of a reply, kept only when their quote is in what the tools returned; never throws */
export function parseFacts(content: string | null, material: string): Array<{ text: string; source: string; url?: string }> {
  let parsed: unknown
  try { parsed = JSON.parse((content ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) } catch { return [] }
  const list = (parsed as { facts?: unknown })?.facts
  if (!Array.isArray(list)) return []
  const out: Array<{ text: string; source: string; url?: string }> = []
  const received = receivedUrls(material)
  for (const item of list) {
    const o = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    const text = typeof o.text === 'string' ? o.text.trim() : ''
    const source = typeof o.source === 'string' ? readableSource(o.source.trim()) : ''
    const quote = typeof o.quote === 'string' ? o.quote.trim() : ''
    // sourced: a real record name, and an excerpt Ole can find in the lookups' results (#37, #39)
    if (!text || !source || onlyHeadings(source, new Set()) || !quote || overlap(quote, material) < EXCERPT_MATCH) continue
    // a link is kept only if Ole received that exact address (#42, #107)
    const given = typeof o.url === 'string' ? o.url.trim() : undefined
    const url = keepLink(given, received) ? given : undefined
    out.push({ text, source, ...(url ? { url } : {}) })
    if (out.length === FACTS_MAX) break
  }
  return out
}

/** words that, straight after a term, say it is a product or a feature: "Northwind gateway", "Contoso API" */
const PRODUCT_WORD = String.raw`(?:apis?|sdks?|cli|plugins?|plug-ins?|clusters?|gateways?|servers?|operators?|integrations?|dashboards?|features?|modules?|services?|versions?|releases?|apps?|platforms?|connectors?|extensions?|librar(?:y|ies)|agents?|controllers?|proxy|proxies|instances?|licen[cs]es?|editions?|consoles?|pipelines?|deployments?|charts?|workflows?|configs?|configuration|endpoints?|upgrades?|nodes?|databases?|db|engine|runtime|framework|toolkit|add-?ons?|widgets?|modes?)`
/** words that, straight before a term, say it is something used, not someone: "running Northwind", "upgraded to Contoso" */
const PRODUCT_VERB = String.raw`(?:use|uses|using|used|run|runs|running|ran|deploy|deploys|deploying|deployed|install|installs|installing|installed|upgrade|upgrades|upgrading|upgraded|enable|enables|enabling|enabled|configure|configures|configuring|configured|migrate|migrating|migrated|integrate|integrating|integrated)(?:\s+(?:to|from|on|with|into))?(?:\s+(?:the|our|their|your|a|an))?`
/** common products and tools a call names, lower case; never looked up as organizations */
export const KNOWN_PRODUCTS = new Set(('kubernetes docker terraform ansible kafka postgres postgresql mysql redis mongodb elasticsearch linux windows macos ubuntu '
  + 'jenkins grafana prometheus envoy nginx python java javascript typescript golang rust node react excel powerpoint jira confluence github gitlab '
  + 'slack zoom teams okta vault consul helm argo openshift lambda bedrock copilot chatgpt').split(' '))

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Whether a name the call said is a product or feature rather than an organization, person or project (#109): a known
 * product; said straight before a product word ("Northwind gateway") or after a usage verb ("running Northwind"), in
 * the line or in what Ole has read; or written in lower case or CamelCase in most of the places Ole's material
 * (briefing, lookups) has it. Pure string work.
 */
export function productTerm(term: string, o: { said?: string; material?: string } = {}): boolean {
  const t = term.trim()
  if (!t) return false
  if (KNOWN_PRODUCTS.has(t.toLowerCase())) return true
  const name = t.split(/\s+/).map(escapeRe).join('\\s+')
  const text = `${o.said ?? ''}\n${o.material ?? ''}`
  if (new RegExp(`(?<![\\p{L}\\p{N}])${name}\\s+${PRODUCT_WORD}(?![\\p{L}\\p{N}])`, 'iu').test(text)) return true
  if (new RegExp(`(?<![\\p{L}\\p{N}])${PRODUCT_VERB}\\s+${name}(?![\\p{L}\\p{N}])`, 'iu').test(text)) return true
  const seen = [...(o.material ?? '').matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${name}(?![\\p{L}\\p{N}])`, 'giu'))].map(m => m[0])
  if (!seen.length) return false
  const productish = seen.filter(w => w === w.toLowerCase() || /\p{Ll}\p{Lu}/u.test(w)).length
  return productish * 2 > seen.length
}

export type Enricher = {
  /** a line of the call; own: the user's track */
  push(line: TranscriptLine, own?: boolean): void
  stop(): void
  /** names waiting for their lookup */
  queued(): number
}

export function createEnricher(o: {
  chat: ChatFn
  /** the tools the servers offer now; the docs ones and non-lookups are left out here */
  tools: () => OleTool[]
  callTool: CallToolFn
  context: () => PreparedContext | null
  /** what Ole has read during the call besides the briefing (the bullets' lookups), for telling products apart (#109) */
  material?: () => string
  /** adds a section to the briefing */
  onSection: (markdown: string) => void
  /** a bullets turn or a briefing is running: the next lookup waits for it */
  busy?: () => boolean
  /** one line per name, never the name: its length, the lookups and the facts added */
  log?: (line: string) => void
  now?: () => number
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void }
  maxTerms?: number
  gapMs?: number
}): Enricher {
  const now = o.now ?? Date.now
  const timers = o.timers ?? { set: (fn: () => void, ms: number): unknown => setTimeout(fn, ms), clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) }
  const log = o.log ?? ((line: string) => console.info(line))
  const maxTerms = o.maxTerms ?? ENRICH_MAX_TERMS
  const gapMs = o.gapMs ?? ENRICH_GAP_MS
  /** every name taken this call, lower case: each is looked up once */
  const taken = new Set<string>()
  const queue: Array<{ term: string; said: string }> = []
  let stopped = false, running = false, lastStart = -Infinity
  let timer: unknown = null

  const materialNow = () => { const c = o.context(); return `${c?.text ?? ''}\n${o.material?.() ?? ''}` }
  /** the briefing (with the meeting title and focus) already names every word of it */
  const covered = (term: string) => {
    const c = o.context()
    const known = knownWords(`${c?.meetingTitle ?? ''}\n${c?.focus ?? ''}\n${c?.text ?? ''}`)
    return term.toLowerCase().split(/\s+/).every(w => known.has(w))
  }

  const pump = () => {
    if (stopped || running || !queue.length || timer !== null) return
    let wait = lastStart + gapMs - now()
    if (wait <= 0 && o.busy?.()) wait = ENRICH_RETRY_MS
    if (wait > 0) { timer = timers.set(() => { timer = null; pump() }, wait); return }
    void run(queue.shift()!)
  }

  const run = async (item: { term: string; said: string }) => {
    running = true
    lastStart = now()
    let lookups = 0
    try {
      // the briefing may have been prepared, or another section added, since the name was heard
      if (covered(item.term)) return
      // a product or feature, now that Ole may have read more about it (#109)
      if (productTerm(item.term, { said: item.said, material: materialNow() })) { log(`ole enrich: name of ${item.term.length} chars, a product, not looked up`); return }
      const offered = enrichTools(o.tools())
      if (!offered.length) { log(`ole enrich: name of ${item.term.length} chars, no tools to look it up`); return }
      const allowed = new Set(offered.map(t => t.name))
      const c = o.context()
      const messages: ChatMessage[] = [
        { role: 'system', content: ENRICH_SYSTEM },
        { role: 'user', content: [`Name: ${item.term}`, `Said on the call: "${item.said.slice(0, 300)}"`, c?.meetingTitle ? `Meeting: ${c.meetingTitle}` : null].filter(Boolean).join('\n') },
      ]
      const tools = { tools: toOpenAiTools(offered) }
      const asked = new Set<string>()
      let reply = await o.chat({ messages, ...tools, response_format: { type: 'json_object' } })
      for (let round = 1; reply.tool_calls?.length; round++) {
        if (stopped) return
        messages.push({ role: 'assistant', content: reply.content, tool_calls: reply.tool_calls })
        const answered = await Promise.all(reply.tool_calls.map(async call => {
          const name = call.function.name
          if (!allowed.has(name)) return 'not allowed: unknown tool'
          let args: unknown
          try { args = call.function.arguments?.trim() ? JSON.parse(call.function.arguments) : {} } catch { return 'not allowed: invalid arguments' }
          if (!args || typeof args !== 'object' || Array.isArray(args)) return 'not allowed: invalid arguments'
          const key = callKey(name, args)
          if (asked.has(key)) return 'not allowed: already looked up'
          if (lookups >= ENRICH_LOOKUPS) return 'not allowed: lookup limit reached, answer from what you have'
          asked.add(key); lookups++
          try { return await o.callTool(name, JSON.stringify(args)) } catch { return 'lookup failed' }
        }))
        reply.tool_calls.forEach((call, i) => messages.push({ role: 'tool', tool_call_id: call.id, content: answered[i] }))
        reply = await o.chat({ messages, ...(round < ENRICH_ROUNDS ? tools : {}), response_format: { type: 'json_object' } })
        if (round >= ENRICH_ROUNDS) break
      }
      if (stopped) return
      // facts come only from what the servers returned: no useful lookup, no section
      const material = messages.filter(m => m.role === 'tool' && !EMPTY_RESULT.test((m.content ?? '').trim())).map(m => m.content ?? '').join('\n')
      // sources name no organization but the meeting's own and the one looked up (#109)
      const rules = anonymityFor(o.context(), [o.context()?.text ?? '', material], [item.term])
      // the fact's own link is replaced by what anonymizing kept, never spread back over it (#116)
      const facts = parseFacts(reply.content, material).map(f => ({ text: f.text, ...anonymizeSourceLink(f.source, f.url, rules) }))
      const section = material.trim() ? mentionedSection(item.term, facts) : ''
      log(`ole enrich: name of ${item.term.length} chars, ${lookups} lookups, ${section ? `${section.split('\n').length - 1} facts added` : 'nothing found'}`)
      if (section && !stopped) o.onSection(section)
    } catch (e) {
      // the briefing stays as it is; the log says only what kind of failure, never a server's words
      log(`ole enrich: name of ${item.term.length} chars, ${lookups} lookups, failed: ${classifyFailure(e instanceof Error ? e.message : String(e))}`)
    } finally {
      running = false
      pump()
    }
  }

  return {
    push(line, own = line.speaker.trim().toLowerCase() === 'me') {
      if (stopped || !line.text.trim()) return
      // only the other side's names, as for fast turns (#79). On a call with no matching record too, and with the
      // single-record tools #57 keeps from bullets: finding who they are, or who they talk about, is the point
      if (own) return
      for (const term of nameTerms(line.text)) {
        const key = term.toLowerCase()
        if (taken.has(key) || covered(term)) continue
        // products and features aren't organizations, people or projects (#109); they don't take a slot either
        if (productTerm(term, { said: line.text, material: materialNow() })) continue
        if (taken.size >= maxTerms) break
        taken.add(key)
        queue.push({ term, said: line.text })
      }
      pump()
    },
    stop() {
      stopped = true
      queue.length = 0
      if (timer !== null) timers.clear(timer)
      timer = null
    },
    queued: () => queue.length,
  }
}
