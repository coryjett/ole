// Ole: Ask as a chat column on the right of a call's note (#148), the way a call app shows its chat. Wide note
// views get the column; narrow ones keep the docked panel at the bottom (#122). The pure parts are here; the
// component is OleAskColumn in OleAsk.tsx.
import { useLayoutEffect, useState } from 'react'
import type { OleLiveState } from '../../../shared/types'

/** the note view's width (px) from which Ask is a column instead of the bottom dock */
export const ASK_COLUMN_BREAKPOINT = 1000
/** the column's width (px) when open */
export const ASK_COLUMN_WIDTH = 320
/** the collapsed strip's width (px) */
export const ASK_STRIP_WIDTH = 36
/** where the collapsed choice is kept on this Mac */
export const ASK_COLUMN_KEY = 'ole:ask-column-collapsed'

/** whether a note view this wide gets the column; an unknown width (0, NaN) keeps the dock */
export function askColumnFits(width: number): boolean {
  return Number.isFinite(width) && width >= ASK_COLUMN_BREAKPOINT
}

/**
 * Whether the column is on screen: a wide note during its own call, while live context can answer (the same
 * rule as the dock, #122 and #125). When it is not, the dock and the Live tab's answer list stay as they were.
 */
export function askColumnShown(o: { wide: boolean; recording: boolean; meetingId: string; state: OleLiveState | null }): boolean {
  return o.wide && o.recording && !!o.state && o.state.meetingId === o.meetingId && !o.state.blocked
}

type Store = Pick<Storage, 'getItem' | 'setItem'>
const store = (): Store | undefined => {
  try { return globalThis.localStorage ?? undefined } catch { return undefined }
}

/** the remembered choice, read synchronously so the first paint is right; open unless collapsed was saved */
export function readAskColumnCollapsed(s: Store | undefined = store()): boolean {
  try { return s?.getItem(ASK_COLUMN_KEY) === '1' } catch { return false }
}

/** remembers the choice; a storage that throws (private mode, full) just doesn't remember */
export function writeAskColumnCollapsed(collapsed: boolean, s: Store | undefined = store()): void {
  try { s?.setItem(ASK_COLUMN_KEY, collapsed ? '1' : '0') } catch { /* not remembered */ }
}

/**
 * Whether the note view (the element handed to `ref`) is wide enough for the column, followed live with a
 * ResizeObserver. False until measured, and wherever ResizeObserver is missing.
 */
export function useAskColumnWide(): { ref: (el: HTMLElement | null) => void; wide: boolean } {
  const [el, setEl] = useState<HTMLElement | null>(null)
  const [wide, setWide] = useState(false)
  useLayoutEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return
    const measure = () => setWide(askColumnFits(el.getBoundingClientRect().width))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [el])
  return { ref: setEl, wide }
}
