// Ole's tabs on the note page (#108): which exist, which one shows, the Live badge and the quick note. Pure, so it is
// tested without a DOM.
import type { WidgetView } from '../../../shared/types'

/** live and briefing during a call; context and briefing on a saved meeting */
export type OleTab = 'live' | 'briefing' | 'context'
export type NoteTab = 'transcript' | 'notes' | OleTab

export const OLE_TABS: readonly OleTab[] = ['live', 'briefing', 'context']
export const isOleTab = (tab: string): tab is OleTab => (OLE_TABS as readonly string[]).includes(tab)

export const OLE_TAB_LABEL: Record<OleTab, string> = { live: 'Live', briefing: 'Briefing', context: 'Context' }

/** what Ole kept for a saved meeting */
export type OleSavedParts = { bullets: number; answers: number; lists: number; briefing: boolean }

/**
 * recording: Live and Briefing. After the call none: the note is Transcript, Summary and My notes (#170); what Ole kept
 * feeds the summary (#168) and its sources sit under it (OleCallSources)
 */
export function oleTabs(recording: boolean, _saved: OleSavedParts | null): OleTab[] {
  return recording ? ['live', 'briefing'] : []
}

/** the tab to show for the one chosen: an Ole tab that isn't there now becomes its counterpart (live and context), else My notes */
export function fitTab(chosen: NoteTab, tabs: readonly OleTab[]): NoteTab {
  if (!isOleTab(chosen) || tabs.includes(chosen)) return chosen
  const twin = chosen === 'live' ? 'context' : chosen === 'context' ? 'live' : null
  return twin && tabs.includes(twin) ? twin : 'notes'
}

/** bullets that arrived while Live wasn't shown */
export function unseenCount(ids: readonly string[], seen: ReadonlySet<string>): number {
  let n = 0
  for (const id of ids) if (!seen.has(id)) n++
  return n
}

/** the call time on the recorder's clock, counting on from its last snapshot while it runs */
export function callElapsedMs(view: Pick<WidgetView, 'kind' | 'paused' | 'elapsedMs' | 'at'> | null, now: number): number {
  if (!view) return 0
  return Math.max(0, view.elapsedMs + (view.kind === 'recording' && !view.paused ? Math.max(0, now - view.at) : 0))
}

/** mm:ss; minutes keep counting past an hour (75:03) */
export function callTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/** My notes with `- [mm:ss] text` added as its last line; null when the text is empty (nothing to add) */
export function appendQuickNote(mine: string, text: string, elapsedMs: number): string | null {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return null
  const line = `- [${callTime(elapsedMs)}] ${clean}`
  if (!mine.trim()) return line
  return `${mine.replace(/\n+$/, '')}\n${line}`
}

/** the quick-note bar's keys: Enter adds (never Shift+Enter or mid-composition), Esc leaves the field */
export function quickNoteKey(e: { key: string; shiftKey?: boolean; isComposing?: boolean }): 'add' | 'leave' | null {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) return 'add'
  if (e.key === 'Escape') return 'leave'
  return null
}

/** a quick-note line: one starting with ">" is a direction for Ole (#176), anything else goes to My notes; null when empty */
export function quickNoteTarget(text: string): { steer: string } | { note: string } | null {
  const t = text.trim()
  if (t.startsWith('>')) { const d = t.slice(1).trim(); return d ? { steer: d } : null }
  return t ? { note: t } : null
}
