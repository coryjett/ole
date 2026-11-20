// Ole: which links a bullet, answer or fact may carry, and how a web-address source reads (#42, #102, #107).
// Host-agnostic: no electron imports.

/** a link longer than this is never kept */
export const LINK_MAX = 500
/** a label built from an address is cut to this many characters */
export const LABEL_MAX = 80

/** what splits material into candidate addresses: whitespace, quotes, angle brackets, parentheses */
const SPLIT = /[\s"'`“”‘’<>()]+/u
/** punctuation that ends a sentence or a bracket, not an address */
const TRAILING = /[.,;:)\]]+$/

/** every https address in what Ole received, exactly as written there (#107) */
export function receivedUrls(material: string): Set<string> {
  const out = new Set<string>()
  for (const token of material.split(SPLIT)) {
    const t = token.replace(TRAILING, '')
    if (/^https:\/\//i.test(t)) out.add(t)
  }
  return out
}

/**
 * A link is kept only if Ole received that exact address (not a longer or shorter one), it is https, it carries no
 * username or password, and it isn't absurdly long (#42, #107).
 */
export function keepLink(url: string | undefined, received: ReadonlySet<string>): url is string {
  if (typeof url !== 'string' || !url || url.length > LINK_MAX || !received.has(url)) return false
  if (url.slice(0, 8).toLowerCase() !== 'https://') return false
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && !u.username && !u.password
  } catch { return false }
}

/** Unicode control and format characters: bidi overrides and isolates, zero-width characters, and the like */
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu

/** a label with no hidden characters, at most LABEL_MAX characters (#107) */
export function cleanLabel(s: string): string {
  const chars = [...s.replace(INVISIBLE, '').trim()]
  return chars.length > LABEL_MAX ? `${chars.slice(0, LABEL_MAX - 1).join('').trimEnd()}…` : chars.join('')
}

/** a short label for a web-address source: the site and the last part of the path ("docs.example.com › jwt") (#102) */
export function sourceLabel(address: string): string {
  try {
    const u = new URL(address)
    const last = u.pathname.split('/').filter(Boolean).at(-1)
    return cleanLabel(last ? `${u.host} › ${decodeURIComponent(last).replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[-_]+/g, ' ')}` : u.host)
  } catch { return cleanLabel(address.slice(0, 60)) }
}

/**
 * A source that is itself a web address (#102): shown as a short label, and used as the link only when Ole received
 * that exact address (#42, #107). null when the source isn't an address.
 */
export function urlSource(source: string, received: ReadonlySet<string>): { source: string; url?: string } | null {
  const address = source.trim().replace(TRAILING, '')
  if (!/^https?:\/\/[^\s"<>]{3,500}$/i.test(address)) return null
  return { source: sourceLabel(address), ...(keepLink(address, received) ? { url: address } : {}) }
}

/**
 * The link and label a bullet or answer ends up with (#107): the model's own link if Ole received it, else the source
 * when that is a received address. A source that was an address is labelled from the link actually used; a text
 * source is kept as the model wrote it.
 */
export function linkAndLabel(given: string | undefined, source: string | undefined, received: ReadonlySet<string>): { source?: string; url?: string } {
  const g = typeof given === 'string' ? given.trim() : undefined
  const kept = keepLink(g, received) ? g : undefined
  const asAddress = source ? urlSource(source, received) : null
  const url = kept ?? asAddress?.url
  const label = asAddress ? (url ? sourceLabel(url) : asAddress.source) : source
  return { ...(label ? { source: label } : {}), ...(url ? { url } : {}) }
}
