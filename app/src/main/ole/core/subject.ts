// Ole: who an unmatched call is with, picked up from the conversation (#126). While the briefing has no matched
// record, names the other side says (the same term detection and product filter as mid-call enrichment, #86, #109)
// are checked against the user's records with cheap lookups: the meeting-context tool with the name as focus, else an
// account-style search, only tools allowed to receive names (#91). Resolved names become one-click choices in the UI;
// the session prepares for one when the user picks it, or by itself once a minute has passed (see session.ts).
// The decisions are pure functions below; createSubjectResolver only queues and runs the lookups.
import type { OleTool } from './types'
import { nameTerms, type TranscriptLine } from './bullets'
import { mayGetNames, productTerm } from './enrich'
import { isLiveTool } from './tools'
import { mentions } from './anonymize'

/** names looked up per call */
export const SUBJECT_LOOKUPS_MAX = 4
/** how long after the first resolved name Ole prepares for it by itself */
export const SUBJECT_AUTO_PICK_MS = 60_000
/** how long to wait before trying again while a Prepare is running */
export const SUBJECT_RETRY_MS = 2_000
/** a typed or heard name is cut to this */
export const SUBJECT_NAME_MAX = 200

/**
 * The names in one transcript line worth checking (pure): none on the user's own track, none once the briefing has a
 * matched record, none past the per-call cap. Each name once per call (taken, lower case), products and features
 * skipped (#109) without taking a slot.
 */
export function subjectTerms(o: {
  line: TranscriptLine
  own: boolean
  matched: boolean
  taken: ReadonlySet<string>
  /** what Ole has read (the briefing), for telling products apart */
  material?: string
  max?: number
}): string[] {
  if (o.own || o.matched || !o.line.text.trim()) return []
  const max = o.max ?? SUBJECT_LOOKUPS_MAX
  const out: string[] = []
  const seen = new Set(o.taken)
  for (const term of nameTerms(o.line.text)) {
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    if (productTerm(term, { said: o.line.text, material: o.material ?? '' })) continue
    if (seen.size >= max) break
    seen.add(key)
    out.push(term)
  }
  return out
}

/**
 * Whether Ole should now prepare for the first resolved name by itself (pure): a minute after it resolved, only when
 * the user has chosen nothing, Ole hasn't already done so this call, the briefing is still unmatched and no Prepare is
 * running.
 */
export function autoPickDue(o: { firstResolvedAt: number | null; now: number; chosen: boolean; autoPicked: boolean; matched: boolean; preparing: boolean; afterMs?: number }): boolean {
  if (o.firstResolvedAt === null || o.chosen || o.autoPicked || o.matched || o.preparing) return false
  return o.now - o.firstResolvedAt >= (o.afterMs ?? SUBJECT_AUTO_PICK_MS)
}

/** a tool named like a search of organizations or accounts, lookup-style (#15) and allowed to receive names (#91) */
const ACCOUNT_SEARCH = /^(?:search|find|lookup|list|query|resolve)[_-]?.*(?:account|compan|organi[sz]ation|customer|client)/i
export function accountSearchTools(tools: OleTool[]): OleTool[] {
  return tools.filter(t => isLiveTool(t) && mayGetNames(t) && ACCOUNT_SEARCH.test(t.tool))
}

/**
 * The argument a search tool takes the name in: the first property its schema declares among the usual query names.
 * null when it declares none of them: the search is skipped, since an argument-less search proves nothing.
 */
const QUERY_KEYS = ['query', 'q', 'name', 'search', 'term', 'keyword', 'text', 'account_name', 'company', 'company_name']
export function searchArgs(tool: OleTool, name: string): Record<string, string> | null {
  const props = tool.parameters?.properties
  const declared = props && typeof props === 'object' ? Object.keys(props) : []
  const key = QUERY_KEYS.find(k => declared.includes(k))
  return key ? { [key]: name } : null
}

/** a result that says it found nothing, whatever else it holds */
const NEGATIVE = /^(?:error:|not allowed:|lookup failed)|\bno (?:match(?:es|ing)?|results?|records?|accounts?|compan(?:y|ies)|organi[sz]ations?)\b|\bnot found\b|\b0 (?:results?|matches|records?|accounts?)\b|\bnothing found\b/i
/** a field that holds a record's name */
const NAME_KEY = /^(?:name|title|display_?name|full_?name|(?:account|company|organi[sz]ation|customer|client|org)(?:_?name)?)$/i
const MATCH_KEY = /^match(?:ed)?_?(?:by|on)?$/i

/** whether a parsed value holds, at most a few levels down, a record whose name field names this name */
function namesRecord(v: unknown, name: string, depth = 0): boolean {
  if (depth > 4 || !v || typeof v !== 'object') return false
  if (Array.isArray(v)) return v.some(x => namesRecord(x, name, depth + 1))
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (typeof x === 'string' && NAME_KEY.test(k) && mentions(x, name) > 0) return true
    if (x && typeof x === 'object' && namesRecord(x, name, depth + 1)) return true
  }
  return false
}

/**
 * Whether a lookup's result positively found this name (#126): structured JSON, not a refusal or a "nothing found"
 * phrase, holding a record whose name field names it (whole words, any case, legal suffixes aside), or a server match
 * (matchedBy set) whose result names it. Plain text, an empty list or the query echoed back never count.
 */
export function resultNames(result: string, name: string): boolean {
  const text = result.trim()
  if (!text || NEGATIVE.test(text)) return false
  let v: unknown
  try { v = JSON.parse(text) } catch { return false }
  if (!v || typeof v !== 'object') return false
  if (namesRecord(v, name)) return true
  if (!Array.isArray(v)) {
    const matched = Object.entries(v as Record<string, unknown>).some(([k, x]) => MATCH_KEY.test(k) && x !== null && x !== false && x !== '' && typeof x !== 'object')
    if (matched && mentions(text, name) > 0) return true
  }
  return false
}

export type Candidate = { name: string; resolved: true }

export type SubjectResolution = { resolved: boolean; via: 'context' | 'search' | null; lookups: number; failed?: string }

export type SubjectResolver = {
  /** a line of the call; own: the user's track */
  push(line: TranscriptLine, own: boolean): void
  /** the names that resolved, in the order heard */
  candidates(): Candidate[]
  /** when the first name resolved (null: none yet) */
  firstResolvedAt(): number | null
  stop(): void
}

export function createSubjectResolver(o: {
  /** checks one name; never throws */
  resolve: (name: string) => Promise<SubjectResolution>
  /** the briefing has a matched record: nothing more is looked up */
  matched: () => boolean
  /** a Prepare is running: the next lookup waits for it */
  busy?: () => boolean
  material?: () => string
  onResolved: () => void
  /** one line per name, never the name */
  log?: (line: string) => void
  now: () => number
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void }
  max?: number
}): SubjectResolver {
  const timers = o.timers ?? { set: (fn: () => void, ms: number): unknown => setTimeout(fn, ms), clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) }
  const log = o.log ?? ((line: string) => console.info(line))
  const taken = new Set<string>()
  const queue: string[] = []
  const found: Candidate[] = []
  let first: number | null = null
  let running = false, stopped = false
  let timer: unknown = null

  const pump = () => {
    if (stopped || running || timer !== null || !queue.length) return
    if (o.matched()) { queue.length = 0; return }
    if (o.busy?.()) { timer = timers.set(() => { timer = null; pump() }, SUBJECT_RETRY_MS); return }
    void run(queue.shift()!)
  }
  const run = async (name: string) => {
    running = true
    try {
      const r = await o.resolve(name)
      if (stopped) return
      log(`ole subject: name of ${name.length} chars, ${r.lookups} lookups, ${r.failed ? `failed: ${r.failed}` : r.resolved ? `resolved via ${r.via === 'search' ? 'search' : 'meeting context'}` : 'not found'}`)
      if (r.resolved) {
        found.push({ name, resolved: true })
        if (first === null) first = o.now()
        o.onResolved()
      }
    } finally {
      running = false
      pump()
    }
  }

  return {
    push(line, own) {
      if (stopped) return
      const terms = subjectTerms({ line, own, matched: o.matched(), taken, material: o.material?.() ?? '', max: o.max })
      for (const t of terms) { taken.add(t.toLowerCase()); queue.push(t) }
      pump()
    },
    candidates: () => [...found],
    firstResolvedAt: () => first,
    stop() {
      stopped = true
      queue.length = 0
      if (timer !== null) timers.clear(timer)
      timer = null
    },
  }
}
