// Ole: sources name only the meeting's own organisation (#109). The bullet text already keeps other organisations
// anonymous (the prompts say so); a source line ("call records: <another company>") or a mid-call section's source
// could still name one on a shared screen. This module finds the organisation names Ole can identify in what it
// received (tool results, "Kind: Name" sources) and replaces any that aren't the meeting's own with a description.
// Host-agnostic and pure: no imports.

/** an organisation Ole can identify, with a description when a result gave its industry or size */
export type KnownOrg = { name: string; description?: string }

/** what a source says instead of a name Ole knows nothing more about */
export const ANOTHER_ORG = 'another organisation'

/** keys (lower case, without _ - . or spaces) whose string value is an organisation's name */
const ORG_NAME_KEY = /^(?:account|company|organi[sz]ation|customer|client|partner|prospect|org|employer)(?:name)?$/
/** keys whose object value is an organisation, so its "name" is one */
const ORG_OBJECT_KEY = /^(?:account|accounts|company|companies|organi[sz]ation|organi[sz]ations|customer|customers|client|clients|partner|partners|prospect|prospects|org|orgs)$/
const INDUSTRY_KEY = /^(?:industry|sector|vertical|accountindustry|companyindustry)$/
const SEGMENT_KEY = /^(?:segment|size|tier|companysize|accountsegment|marketsegment)$/
const EMPLOYEES_KEY = /^(?:employees|employeecount|numberofemployees|headcount|companyemployees)$/

/** the record kinds a "Kind: Name" source or line names an organisation with */
const ORG_KIND = String.raw`(?:account|customer|company|organi[sz]ation|org|client|partner|prospect|call records?|call notes)`
/** a capitalised name after "Kind:", up to 5 words, stopping at punctuation that ends it */
const NAME_RUN = String.raw`([A-Z][\p{L}\p{N}&'’.-]*(?:[ \t]+(?:[A-Z0-9&][\p{L}\p{N}&'’.-]*|of|and|de|du|the|&)){0,4})`
/** "account: ", "From call records: ", "Account Name = ": the kind in any case; the name after it must be capitalised */
const KIND_AT = new RegExp(String.raw`(?:^|[\s;,(\[|"'])${ORG_KIND}(?:[ _]?name)?[ \t]*[:=][ \t]*`, 'giu')
const NAME_AT = new RegExp(`^${NAME_RUN}`, 'u')
/** "account_name": "Example Corp" in a result that isn't valid JSON (cut short by the tool runner, or embedded) */
const QUOTED_NAME = /"((?:account|company|organi[sz]ation|customer|client|partner|prospect|org)[_ -]?name|accountName|companyName|organi[sz]ationName|customerName|clientName)"\s*:\s*"([^"\\]{1,80})"/gi
/** "account": {"id": 7, "name": "Example Corp"} in a result that isn't valid JSON: a bare name under an organisation key (#116) */
const BARE_NAME = /"(?:account|company|organi[sz]ation|customer|client|partner|prospect|org)s?"\s*:\s*\[?\s*\{\s*(?:"[^"\\]{1,40}"\s*:\s*(?:"[^"\\]{0,200}"|-?[\d.eE+-]+|true|false|null)\s*,\s*){0,12}"name"\s*:\s*"([^"\\]{1,80})"/gi

/** capitalised words that start no organisation's name: months, days, and words a "Kind:" line starts with */
const NOT_A_NAME = new Set(('january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec '
  + 'monday tuesday wednesday thursday friday saturday sunday today yesterday tomorrow none unknown yes no true false null n/a na tbd the a an').split(' '))
/** legal and group suffixes: "Example Corp" is also known as "Example" */
const SUFFIX = /[\s,]+(?:inc|incorporated|corp|corporation|co|company|llc|l\.l\.c|ltd|limited|plc|gmbh|ag|sa|s\.a|nv|bv|ab|oy|as|pte|pty|group|holdings|holding|international|intl)\.?$/i

const keyOf = (k: string) => k.toLowerCase().replace(/[\s_.-]+/g, '')
const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim()

/** a name worth matching: 3+ characters with a letter, not a month, a day or a filler word */
function plausibleName(raw: string): string | null {
  const name = raw.replace(/\s+/g, ' ').replace(/^[\s"'“‘(]+|[\s"'”’),.;:]+$/g, '').trim()
  if (name.length < 3 || name.length > 80 || !/\p{L}/u.test(name)) return null
  const first = name.split(' ')[0]
  // a month, a day, a filler word, or a first word with a digit (Q3, 2026) starts no organisation's name here
  if (NOT_A_NAME.has(name.toLowerCase()) || NOT_A_NAME.has(first.toLowerCase()) || /\d/.test(first)) return null
  return name
}

/**
 * A name from an explicit organisation-name field (#116): the server said it is one, so the free-text filter doesn't
 * apply (digits and short names such as "3M" count); only a placeholder ("none", "n/a", "unknown") or an empty value
 * is not a name.
 */
function fieldName(raw: string): string | null {
  const name = raw.replace(/\s+/g, ' ').replace(/^[\s"'“‘(]+|[\s"'”’),;:]+$/g, '').trim()
  if (name.length < 2 || name.length > 80 || !/[\p{L}\p{N}]/u.test(name) || NOT_A_NAME.has(name.toLowerCase())) return null
  return name
}

/** a name without its legal suffix ("Example Corp" gives "Example"), when what is left is still a name */
function coreName(name: string): string | null {
  const core = name.replace(SUFFIX, '').trim()
  return core !== name && core.length >= 4 ? core : null
}

/** a size word from a segment or tier field */
function sizeOfSegment(v: string): string | null {
  const s = v.toLowerCase()
  if (/enterprise|strategic|large|global|major|key/.test(s)) return 'large'
  if (/mid|commercial|medium/.test(s)) return 'mid-sized'
  if (/smb|small|startup|start-up|growth|emerging/.test(s)) return 'small'
  return null
}

/** a size word from a headcount */
function sizeOfHeadcount(v: unknown): string | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[,\s+]/g, '')) : NaN
  if (!Number.isFinite(n) || n <= 0) return null
  return n >= 5000 ? 'large' : n >= 500 ? 'mid-sized' : 'small'
}

/** an industry as a few plain lower-case words, or null when it isn't one */
function industryWords(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.replace(/\s+industry$/i, '').replace(/[^\p{L}&,\s-]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
  return s.length >= 3 && s.length <= 40 ? s : null
}

/** "a large financial services company", "a small bank", or undefined when nothing describes it */
export function describeOrg(o: { industry?: string | null; size?: string | null }): string | undefined {
  if (!o.industry && !o.size) return undefined
  const industry = o.industry ?? ''
  const noun = /\b(?:company|firm|bank|insurer|retailer|agency|university|college|school|hospital|startup|organisation|organization|manufacturer|provider|government)$/.test(industry)
    ? industry : `${industry ? `${industry} ` : ''}company`
  const words = [o.size, noun].filter(Boolean).join(' ')
  return `${/^[aeiou]/.test(words) ? 'an' : 'a'} ${words}`
}

/** the description an object's own fields give it */
function describeObject(obj: Record<string, unknown>): string | undefined {
  let industry: string | null = null, size: string | null = null
  for (const [k, v] of Object.entries(obj)) {
    const key = keyOf(k)
    if (!industry && INDUSTRY_KEY.test(key)) industry = industryWords(v)
    else if (!size && SEGMENT_KEY.test(key) && typeof v === 'string') size = sizeOfSegment(v)
    else if (!size && EMPLOYEES_KEY.test(key)) size = sizeOfHeadcount(v)
  }
  return describeOrg({ industry, size })
}

/** cut points tried, from the end, when repairing a result cut short */
const REPAIR_TRIES = 64

/**
 * JSON cut short, repaired (#116): trimmed from the end back to the last point where every value so far is complete
 * (after a closing bracket, before a comma, or just after an opening bracket), with the brackets still open closed.
 * undefined when no such point parses.
 */
export function repairJson(text: string): unknown {
  const stack: string[] = []
  /** [end of the prefix, the closers it needs] */
  const cuts: Array<[number, string]> = []
  let inString = false, escaped = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{' || c === '[') { stack.push(c === '{' ? '}' : ']'); cuts.push([i + 1, stack.slice().reverse().join('')]) }
    else if (c === '}' || c === ']') { if (stack.pop() !== c) return undefined; if (stack.length) cuts.push([i + 1, stack.slice().reverse().join('')]); else break }
    else if (c === ',' && stack.length) cuts.push([i, stack.slice().reverse().join('')])
  }
  for (let k = cuts.length - 1, tries = 0; k >= 0 && tries < REPAIR_TRIES; k--, tries++) {
    const [end, closers] = cuts[k]
    try { return JSON.parse(text.slice(0, end) + closers) } catch { /* an earlier point */ }
  }
  return undefined
}

/** the JSON a result holds: whole, between its first opening and last closing bracket, or repaired when cut short */
function parseJson(text: string): unknown {
  const t = text.trim()
  try { return JSON.parse(t) } catch { /* maybe embedded */ }
  const start = t.search(/[[{]/)
  if (start < 0) return undefined
  const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'))
  if (end > start) { try { return JSON.parse(t.slice(start, end + 1)) } catch { /* maybe cut short */ } }
  return repairJson(t.slice(start))
}

/** organisations in a JSON value, breadth first (the shallowest, most likely the record itself, first) */
function orgsInJson(root: unknown, out: KnownOrg[]): void {
  const queue: Array<{ v: unknown; parentKey: string }> = [{ v: root, parentKey: '' }]
  for (let i = 0; i < queue.length && i < 5000; i++) {
    const { v, parentKey } = queue[i]
    if (Array.isArray(v)) { for (const x of v) queue.push({ v: x, parentKey }); continue }
    if (!v || typeof v !== 'object') continue
    const obj = v as Record<string, unknown>
    const description = describeObject(obj)
    const objectIsOrg = ORG_OBJECT_KEY.test(parentKey) || ['account', 'company', 'organization', 'organisation', 'customer'].includes(String(obj.type ?? obj.kind ?? '').toLowerCase())
    for (const [k, val] of Object.entries(obj)) {
      const key = keyOf(k)
      if (typeof val === 'string' && (ORG_NAME_KEY.test(key) || (key === 'name' && objectIsOrg))) {
        const name = fieldName(val)
        if (name) out.push({ name, ...(description ? { description } : {}) })
      } else if (val && typeof val === 'object') queue.push({ v: val, parentKey: key })
    }
  }
}

/** organisations named in "Kind: Name" form in a text (a source label, a briefing line, a plain-text result) */
export function kindNames(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(KIND_AT)) {
    const run = text.slice(m.index + m[0].length).match(NAME_AT)
    const name = run ? plausibleName(run[1]) : null
    if (name) out.push(name)
  }
  return out
}

/**
 * The organisations Ole can identify in what it received (#109): name fields of JSON results (account, company,
 * organisation, customer, client, partner names, or the name of an object under such a key), with a description
 * when the same object gives an industry, segment or headcount; the same fields in a result that isn't valid JSON;
 * and "Kind: Name" lines. Deduplicated by name, a described entry winning.
 */
export function knownOrganisations(material: string | string[]): KnownOrg[] {
  const found: KnownOrg[] = []
  for (const text of Array.isArray(material) ? material : [material]) {
    if (!text) continue
    const json = /[[{]/.test(text) ? parseJson(text) : undefined
    if (json !== undefined) orgsInJson(json, found)
    for (const m of text.matchAll(QUOTED_NAME)) { const name = fieldName(m[2]); if (name) found.push({ name }) }
    for (const m of text.matchAll(BARE_NAME)) { const name = fieldName(m[1]); if (name) found.push({ name }) }
    for (const name of kindNames(text)) found.push({ name })
  }
  const byName = new Map<string, KnownOrg>()
  for (const o of found) {
    const key = norm(o.name)
    const had = byName.get(key)
    if (!had || (!had.description && o.description)) byName.set(key, o)
  }
  return [...byName.values()]
}

/**
 * What a source is checked against (#109, #116). allowed: the matched record's name(s), plus the name a mid-call
 * section was looked up for; known: the organisations Ole can identify; truncated: Prepare found more organisations
 * than it kept, so every "Kind: Name" a source carries is replaced unless it is an allowed name (fail closed).
 */
export type AnonymityRules = { allowed: string[]; known: Array<string | KnownOrg>; truncated?: boolean }

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** a name as a whole word or words, any case, with spaces matching runs of space, - or _ (as in an address) */
const nameRegex = (name: string, flags = 'giu') =>
  new RegExp(`(?<![\\p{L}\\p{N}])${name.trim().split(/\s+/).map(escape).join('[\\s_+-]+')}(?![\\p{L}\\p{N}])`, flags)

/** a name as the allowlist compares it (#116): lower case, single spaces, every trailing legal suffix taken off */
function canonical(name: string): string {
  let s = norm(name).replace(/[\s,.]+$/, '')
  for (;;) {
    const t = s.replace(SUFFIX, '').replace(/[\s,.]+$/, '').trim()
    if (t === s || !t) return s
    s = t
  }
}

/** whether a name is an allowed one (#116): exactly, once case, spacing and legal suffixes are set aside */
function isAllowed(name: string, allowed: string[]): boolean {
  const c = canonical(name)
  return !!c && allowed.some(a => !!a?.trim() && canonical(a) === c)
}

/** the forms a name is matched in: as given and without its legal suffix */
const formsOf = (name: string): string[] => [name, coreName(name)].filter((s): s is string => !!s)

/** where the allowed names stand in a text: a non-allowed name inside one ("Globex" in "Globex Bank") is left alone */
function allowedSpans(text: string, allowed: string[]): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const a of allowed) {
    if (!a?.trim()) continue
    for (const f of formsOf(a.trim())) for (const m of text.matchAll(nameRegex(f))) out.push([m.index, m.index + m[0].length])
  }
  return out
}
const inside = (spans: Array<[number, number]>, start: number, end: number) => spans.some(([s, e]) => s <= start && end <= e)

/** whether a name stands in a text outside every allowed name */
function namedOutside(text: string, name: string, allowed: string[]): boolean {
  const spans = allowedSpans(text, allowed)
  for (const m of text.matchAll(nameRegex(name))) if (!inside(spans, m.index, m.index + m[0].length)) return true
  return false
}

/** a word that is part of a date, not a name: "12", "3rd", "Nov" */
const DATE_WORD = /^(?:\d{1,4}(?:st|nd|rd|th)?|\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?)$/i
/** what ends the text after "Kind:" when the cap was hit: punctuation that closes a phrase, or a dash between spaces */
const LOOSE_END = /[;,()[\]|\n]|\s[-–—]\s/

/**
 * The text after every "Kind:" in a label, capitalised or not (#116): used only when Prepare found more organisations
 * than it kept, so a name Ole couldn't keep is still replaced. Up to 5 words; a date, or a run starting with an
 * allowed name, is left alone.
 */
function looseKindNames(label: string, allowed: string[]): string[] {
  const out: string[] = []
  for (const m of label.matchAll(KIND_AT)) {
    const rest = label.slice(m.index + m[0].length)
    const end = rest.search(LOOSE_END)
    const run = (end < 0 ? rest : rest.slice(0, end)).trim().split(/\s+/).slice(0, 5).join(' ').replace(/[.:]+$/, '')
    if (!run || !/[\p{L}\p{N}]/u.test(run)) continue
    if (run.split(' ').every(w => DATE_WORD.test(w) || NOT_A_NAME.has(w.toLowerCase().replace(/[.,]$/, '')))) continue
    if (allowed.some(a => a?.trim() && formsOf(a.trim()).some(f => nameRegex(f, 'iu').exec(run)?.index === 0))) continue
    out.push(run)
  }
  return out
}

/** the non-allowed names a label mentions, longest first, each with what replaces it */
function replacements(label: string, o: AnonymityRules): Array<{ name: string; with: string }> {
  const orgs: KnownOrg[] = [
    ...o.known.map(k => typeof k === 'string' ? { name: k } : k),
    ...kindNames(label).map(name => ({ name })),
    ...(o.truncated ? looseKindNames(label, o.allowed).map(name => ({ name })) : []),
  ]
  const out = new Map<string, { name: string; with: string }>()
  for (const org of orgs) {
    const name = fieldName(org.name)
    if (!name || isAllowed(name, o.allowed)) continue
    for (const form of formsOf(name)) {
      if (!namedOutside(label, form, o.allowed)) continue
      const key = norm(form)
      const had = out.get(key)
      if (!had || (had.with === ANOTHER_ORG && org.description)) out.set(key, { name: form, with: org.description ?? ANOTHER_ORG })
    }
  }
  return [...out.values()].sort((a, b) => b.name.length - a.name.length)
}

/** a label with the replacements made, longest first; an occurrence inside an allowed name stays */
function applied(label: string, rs: Array<{ name: string; with: string }>, allowed: string[]): string {
  let out = label
  for (const r of rs) {
    const spans = allowedSpans(out, allowed)
    out = out.replace(nameRegex(r.name), (m: string, offset: number) => inside(spans, offset, offset + m.length) ? m : r.with)
  }
  return out
}

/**
 * A source label with every organisation Ole can identify that isn't the meeting's own replaced by a description
 * (#109): "a large financial services company" when a result gave its industry and size, else "another
 * organisation". allowed: the meeting's matched record name(s) (see bullets.ts anonymityFor), compared exactly once
 * case, spacing and legal suffixes are set aside (#116); known: the organisations from knownOrganisations, plus any
 * "Kind: Name" in the label itself, and when the cap was hit any text after a "Kind:" (#116). Longest names first,
 * whole words, any case; an address-style label ("crm.example.com › example-corp") is matched too.
 */
export function anonymizeSource(label: string, o: AnonymityRules): string {
  return applied(label, replacements(label, o), o.allowed)
}

/**
 * A source and its link after anonymizing (#109, #116): the link is dropped when its address, decoded, names any
 * organisation Ole can identify that isn't allowed (whole words, any case, with or without a legal suffix), whether
 * or not the label named one, since hovering it would show the name.
 */
export function anonymizeSourceLink(source: string, url: string | undefined, o: AnonymityRules): { source: string; url?: string } {
  const rs = replacements(source, o)
  const shown = rs.length ? applied(source, rs, o.allowed) : source
  if (!url) return { source: shown }
  let address = url
  try { address = decodeURIComponent(url) } catch { /* as given */ }
  const names = new Set(rs.map(r => r.name))
  for (const k of o.known) {
    const name = fieldName(typeof k === 'string' ? k : k.name)
    if (name && !isAllowed(name, o.allowed)) for (const f of formsOf(name)) names.add(f)
  }
  const lower = address.toLowerCase()
  const named = [...names].some(n => lower.includes(n.toLowerCase().split(/\s+/)[0]) && namedOutside(address, n, o.allowed))
  return { source: shown, ...(named ? {} : { url }) }
}

/** whether a text names an organisation, with or without its legal suffix; how often */
const mentions = (text: string, name: string) => Math.max(...formsOf(name).map(f => (text.match(nameRegex(f)) ?? []).length))

/**
 * The organisations to keep when there are more than `cap` (#116): those the briefing (and the sources in it) names
 * first, then the rest in the order found.
 */
export function rankOrgs(orgs: KnownOrg[], briefing: string, cap: number): KnownOrg[] {
  const lower = briefing.toLowerCase()
  const named = (o: KnownOrg) => formsOf(o.name).some(f => lower.includes(f.toLowerCase().split(/\s+/)[0]) && nameRegex(f, 'iu').test(briefing))
  const first: KnownOrg[] = [], rest: KnownOrg[] = []
  for (const o of orgs) (named(o) ? first : rest).push(o)
  return [...first, ...rest].slice(0, cap)
}

/** a key whose plain value says how the server matched the meeting: matchedBy, matched_on, match_reason */
const MATCH_KEY = /^match(?:ed)?(?:by|on|reason|type|source|via)?$/
/** a key whose string value is the matched record's name */
const RECORD_NAME_KEY = /^(?:account|company|organi[sz]ation|customer|client|org)(?:name)?$/
/** a key whose object value is the matched record */
const RECORD_OBJECT_KEY = /^(?:account|company|organi[sz]ation|customer|client|org)$/

/**
 * The record the server's own match names (#116): in the object that holds the match (the one with a `matchedBy` or
 * similar beside it, else the result itself), an explicit account, company or organisation name field, or the name of
 * an account, company or organisation object. null when the match names none.
 */
export function matchedRecordName(fastResult: string): string | null {
  const root = /[[{]/.test(fastResult) ? parseJson(fastResult) : undefined
  if (!root || typeof root !== 'object') return null
  let holder: Record<string, unknown> | null = null
  const queue: unknown[] = [root]
  for (let i = 0; i < queue.length && i < 2000 && !holder; i++) {
    const v = queue[i]
    if (Array.isArray(v)) { queue.push(...v); continue }
    if (!v || typeof v !== 'object') continue
    const obj = v as Record<string, unknown>
    if (Object.entries(obj).some(([k, x]) => MATCH_KEY.test(keyOf(k)) && x !== null && typeof x !== 'object')) holder = obj
    else for (const x of Object.values(obj)) if (x && typeof x === 'object') queue.push(x)
  }
  if (!holder) holder = Array.isArray(root) ? null : root as Record<string, unknown>
  if (!holder) return null
  for (const [k, v] of Object.entries(holder)) {
    if (typeof v === 'string' && RECORD_NAME_KEY.test(keyOf(k))) { const n = fieldName(v); if (n) return n }
  }
  for (const [k, v] of Object.entries(holder)) {
    if (!v || typeof v !== 'object' || Array.isArray(v) || !RECORD_OBJECT_KEY.test(keyOf(k))) continue
    for (const [kk, vv] of Object.entries(v as Record<string, unknown>)) {
      const key = keyOf(kk)
      if (typeof vv === 'string' && (key === 'name' || RECORD_NAME_KEY.test(key))) { const n = fieldName(vv); if (n) return n }
    }
  }
  return null
}

/**
 * The matched record's name(s) from what Prepare received (#109, #116), only ever a name the briefing names: the
 * record the server's own match names when it names one (see matchedRecordName), else the known organisation the
 * briefing names most often (twice or more, or the only one it names). The meeting title and the focus only
 * corroborate: among the organisations the briefing names most, one the title or focus names wins.
 */
export function recordNames(o: { fastResult?: string | null; briefing: string; known: KnownOrg[]; meetingTitle?: string | null; focus?: string | null }): string[] {
  if (o.fastResult) {
    const explicit = matchedRecordName(o.fastResult)
    if (explicit) return mentions(o.briefing, explicit) > 0 ? [explicit] : []
  }
  const counts = o.known
    .map(k => ({ name: k.name, n: mentions(o.briefing, k.name) }))
    .filter(c => c.n > 0)
    .sort((a, b) => b.n - a.n)
  if (!counts.length) return []
  const top = counts[0].n
  const backed = counts.find(c => c.n === top && [o.meetingTitle, o.focus].some(t => !!t && mentions(t, c.name) > 0))
  if (backed) return [backed.name]
  return top >= 2 || counts.length === 1 ? [counts[0].name] : []
}
