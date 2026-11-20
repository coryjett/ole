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
const QUOTED_NAME = /"((?:account|company|organi[sz]ation|customer|client|partner|prospect|org)[_ -]?name|accountName|companyName|organi[sz]ationName|customerName|clientName)"\s*:\s*"([^"\\]{2,80})"/gi

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

/** the JSON a result holds, whole or between its first opening and last closing bracket; undefined when none */
function parseJson(text: string): unknown {
  const t = text.trim()
  try { return JSON.parse(t) } catch { /* maybe embedded */ }
  const start = t.search(/[[{]/)
  const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'))
  if (start < 0 || end <= start) return undefined
  try { return JSON.parse(t.slice(start, end + 1)) } catch { return undefined }
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
        const name = plausibleName(val)
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
    for (const m of text.matchAll(QUOTED_NAME)) { const name = plausibleName(m[2]); if (name) found.push({ name }) }
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

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** a name as a whole word or words, any case, with spaces matching runs of space, - or _ (as in an address) */
const nameRegex = (name: string, flags = 'giu') =>
  new RegExp(`(?<![\\p{L}\\p{N}])${name.trim().split(/\s+/).map(escape).join('[\\s_+-]+')}(?![\\p{L}\\p{N}])`, flags)

/** whether a name is one of the allowed ones: the same name, the same without a legal suffix, or within an allowed text */
function isAllowed(name: string, allowed: string[]): boolean {
  const forms = [name, coreName(name)].filter((s): s is string => !!s)
  return allowed.some(a => {
    const aa = a?.trim()
    if (!aa) return false
    const aCore = coreName(aa)
    return forms.some(f => nameRegex(f, 'iu').test(aa) || (aCore !== null && norm(aCore) === norm(f)) || nameRegex(aa, 'iu').test(f))
  })
}

/** the non-allowed names a label mentions, longest first, each with what replaces it */
function replacements(label: string, o: { allowed: string[]; known: Array<string | KnownOrg> }): Array<{ name: string; with: string }> {
  const orgs: KnownOrg[] = [...o.known.map(k => typeof k === 'string' ? { name: k } : k), ...kindNames(label).map(name => ({ name }))]
  const out = new Map<string, { name: string; with: string }>()
  for (const org of orgs) {
    const name = plausibleName(org.name)
    if (!name || isAllowed(name, o.allowed)) continue
    for (const form of [name, coreName(name)]) {
      if (!form || !nameRegex(form, 'iu').test(label)) continue
      const key = norm(form)
      const had = out.get(key)
      if (!had || (had.with === ANOTHER_ORG && org.description)) out.set(key, { name: form, with: org.description ?? ANOTHER_ORG })
    }
  }
  return [...out.values()].sort((a, b) => b.name.length - a.name.length)
}

/**
 * A source label with every organisation Ole can identify that isn't the meeting's own replaced by a description
 * (#109): "a large financial services company" when a result gave its industry and size, else "another
 * organisation". allowed: the meeting's matched record name(s) and title (see bullets.ts anonymityFor); known: the
 * organisations from knownOrganisations, plus any "Kind: Name" in the label itself. Longest names first, whole words,
 * any case; an address-style label ("crm.example.com › example-corp") is matched too.
 */
export function anonymiseSource(label: string, o: { allowed: string[]; known: Array<string | KnownOrg> }): string {
  let out = label
  for (const r of replacements(label, o)) out = out.replace(nameRegex(r.name), r.with)
  return out
}

/**
 * A source and its link after anonymising (#109): when the label had a name replaced and the link spells that name
 * too, the link is dropped, since hovering it would show the name.
 */
export function anonymiseSourceLink(source: string, url: string | undefined, o: { allowed: string[]; known: Array<string | KnownOrg> }): { source: string; url?: string } {
  const rs = replacements(source, o)
  if (!rs.length) return { source, ...(url ? { url } : {}) }
  let shown = source
  for (const r of rs) shown = shown.replace(nameRegex(r.name), r.with)
  let address = url ?? ''
  try { address = decodeURIComponent(address) } catch { /* as given */ }
  const keep = url && !rs.some(r => nameRegex(r.name, 'iu').test(address))
  return { source: shown, ...(keep ? { url } : {}) }
}

/**
 * The matched record's name(s) from what Prepare received (#109): the organisations in the server's own match for the
 * meeting when it gave one (the first, shallowest, is the record), else the known organisation the briefing names
 * most often (twice or more, or the only one it names).
 */
export function recordNames(o: { fastResult?: string | null; briefing: string; known: KnownOrg[] }): string[] {
  if (o.fastResult) {
    const first = knownOrganisations(o.fastResult)[0]
    if (first) return [first.name]
  }
  const counts = o.known
    // the name or, when the briefing shortens it, the name without its suffix (which also counts the full name's mentions)
    .map(k => { const core = coreName(k.name); return { name: k.name, n: Math.max((o.briefing.match(nameRegex(k.name)) ?? []).length, core ? (o.briefing.match(nameRegex(core)) ?? []).length : 0) } })
    .filter(c => c.n > 0)
    .sort((a, b) => b.n - a.n)
  if (!counts.length) return []
  return counts[0].n >= 2 || counts.length === 1 ? [counts[0].name] : []
}
