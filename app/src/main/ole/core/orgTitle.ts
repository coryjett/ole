// Ole: the organization a call was with, in front of the meeting's title the app writes (#154). "Agent Gateway POC
// with Clyde" from a call matched to Example Corp becomes "Example Corp: Agent Gateway POC with Clyde". Only titles
// the app generates get it (the host decides which); a title the person set is never changed.
import { mentions } from './anonymize'
import type { PreparedContext } from './types'

/** the longest organization name kept with a meeting */
export const ORG_MAX = 120

/** an organization name as saved and shown: one line, single spaces, capped; '' when there is none */
export function cleanOrg(org: unknown): string {
  if (typeof org !== 'string') return ''
  // no control, zero-width or direction characters in a saved name or a title (#156)
  const s = org.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '').replace(/\s+/g, ' ').trim()
  return s.length > ORG_MAX ? '' : s
}

/**
 * The title with the organization in front ("Org: title"), or the title as it is when there is no organization or the
 * title already names it: case-insensitive, with or without its legal suffix ("Example Corp" is named by "Example"),
 * by the same matching anonymized sources use (anonymize.ts mentions()).
 */
export function titleWithOrg(title: string, org: string | null | undefined): string {
  const name = cleanOrg(org)
  if (!name || !title.trim()) return title
  if (mentions(title, name) > 0) return title
  return `${name}: ${title}`
}

/**
 * The organization a call's briefing matched (#138: the name in "Briefing for X"), or null when it matched none. The
 * record Prepare matched, else what was prepared for; never the meeting's own title, which names a meeting, not an
 * organization.
 */
export function matchedOrg(prepared: PreparedContext | null, matched: boolean): string | null {
  if (!prepared || !matched) return null
  return cleanOrg(prepared.records?.[0]) || cleanOrg(prepared.focus) || null
}
