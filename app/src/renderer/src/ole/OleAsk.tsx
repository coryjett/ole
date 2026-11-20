// Ole: ask a question during the call (#53, #122, #148). The answer comes from the briefing, the call so far and, when
// needed, a read-only lookup; each answer names its source and links it when Ole has the link.
import { useEffect, useRef, useState, type RefObject } from 'react'
import { PanelRightClose } from 'lucide-react'
import type { OleAnswer } from '../../../main/ole/core/types'
import type { OleLiveState } from '../../../shared/types'
import { SourceName } from './OleBullets'
import { newAskRequestId, registerOleAskDock, shownAnswers } from './oleAskDock'
import { ASK_COLUMN_WIDTH, ASK_STRIP_WIDTH, readAskColumnCollapsed, writeAskColumnCollapsed } from './oleAskColumn'
import { scrollBehavior } from '../motion'

/** what the panel says it answers from, so the route is visible before asking (#122) */
export const OLE_ASK_LABEL = 'Answers from this call and your servers'

function AnswerItem({ a }: { a: OleAnswer }) {
  return <li data-testid="ole-answer" className="widget-preview-bubble text-[13px] leading-[18px]" dir="auto">
    <span className="block text-[11px] leading-[16px] text-[#B8B8C0]">Q: {a.question}</span>
    {a.pending ? <span className="opacity-70">Looking…</span> : <span>{a.text}</span>}
    {a.source && <span className="block text-[11px] leading-[16px] text-[#B8B8C0]">
      <SourceName b={{ source: a.source, url: a.url }} /></span>}
  </li>
}

/** every answer, newest first: the Live tab and a saved meeting's Context */
export function OleAnswers({ answers }: { answers: OleAnswer[] }) {
  if (!answers.length) return null
  return <ul data-testid="ole-answers" role="list" className="mt-2 flex flex-col gap-1">
    {answers.map(a => <AnswerItem key={a.id} a={a} />)}
  </ul>
}

type AskBox = {
  q: string; setQ: (q: string) => void; running: string | null; blocked: boolean
  input: RefObject<HTMLInputElement | null>; ask: () => void; stop: () => void
}

/** the question box both shapes share: the text, the request in flight (its id, for Stop), Ask and Stop */
function useAskBox(state: OleLiveState, meetingId: string | undefined): AskBox {
  const [q, setQ] = useState('')
  const [running, setRunning] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const blocked = !!state.blocked
  const ask = () => {
    const question = q.trim()
    if (!question || running || blocked) return
    const rid = newAskRequestId()
    setRunning(rid); setQ('')
    const done = () => setRunning(r => r === rid ? null : r)
    try { void window.yogurt.ole.ask(question, rid, meetingId ?? state.meetingId ?? undefined).then(done, done) } catch { done() }
  }
  const stop = () => {
    if (!running) return
    try { void window.yogurt.ole.cancelAsk(running).catch(() => {}) } catch { /* the answer is dropped when it comes */ }
    setRunning(null)
    input.current?.focus()
  }
  return { q, setQ, running, blocked, input, ask, stop }
}

/** the input with Clear, and Ask or (while answering) Stop */
function askRow(box: AskBox) {
  const { q, setQ, running, blocked, input, ask, stop } = box
  return <div className="flex items-center gap-1">
    <input ref={input} data-testid="ole-ask-input" className="settings-input w-full" aria-label="Ask Ole about this call" placeholder="Ask Ole about this call…"
      value={q} maxLength={500} disabled={blocked} onChange={e => setQ(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); ask() } }} />
    {q && <button data-testid="ole-ask-clear" aria-label="Clear" className="workspace-button" onClick={() => { setQ(''); input.current?.focus() }}>×</button>}
    {running
      ? <button data-testid="ole-ask-stop" className="workspace-button" onClick={stop}>Stop</button>
      : <button data-testid="ole-ask-send" className="workspace-button" disabled={blocked || !q.trim()} onClick={ask}>Ask</button>}
  </div>
}

/**
 * Ole's Ask during a call (#122): the call's answers above a question box, newest nearest the box, only the latest
 * unless "Show N earlier" is open; Stop while answering. docked: fixed at the bottom of the call's note page, where
 * the host's Ask button and ⌘J focus it (oleAskTakesOver); not shown while live context is blocked, so the host's
 * Ask answers then. Home's call panel shows it undocked. A wide note shows OleAskColumn instead of the dock (#148).
 */
export function OleAskPanel({ state, docked = false, meetingId, defaultExpanded = false }: { state: OleLiveState; docked?: boolean; meetingId?: string; defaultExpanded?: boolean }) {
  const box = useAskBox(state, meetingId)
  const [expanded, setExpanded] = useState(defaultExpanded)
  const { input, blocked } = box
  // docked on a note, the panel belongs to that note's live call only (#125)
  const mine = !docked || (!!meetingId && state.meetingId === meetingId)
  useEffect(() => {
    if (!docked || !meetingId || blocked || !mine) return
    return registerOleAskDock(meetingId, () => { input.current?.focus(); input.current?.scrollIntoView?.({ block: 'nearest' }) })
  }, [docked, meetingId, blocked, mine])
  if (docked && (blocked || !mine)) return null
  const answers = state.answers ?? []
  const shown = shownAnswers(answers, expanded)
  const earlier = answers.length - 1
  return <section data-testid={docked ? 'ole-ask-dock' : 'ole-ask'} aria-label="Ask Ole" className={docked ? 'note-page-width' : 'mt-2'} style={docked ? { paddingTop: 8 } : undefined}>
    {earlier > 0 && <button data-testid="ole-ask-earlier" className="text-action text-[12px]" aria-expanded={expanded} onClick={() => setExpanded(e => !e)}>
      {expanded ? 'Show only the latest' : `Show ${earlier} earlier`}</button>}
    {shown.length > 0 && <ul data-testid="ole-ask-answers" role="list" className="mb-1 flex flex-col gap-1"
      style={expanded ? { maxHeight: '30vh', overflowY: 'auto', overscrollBehavior: 'contain' } : undefined}>
      {shown.map(a => <AnswerItem key={a.id} a={a} />)}
    </ul>}
    <p data-testid="ole-ask-label" className="text-[11px] leading-[16px] text-muted">{OLE_ASK_LABEL}</p>
    {askRow(box)}
  </section>
}

/**
 * Ask as a chat column on the right of a wide call note (#148), on every tab: every answer, oldest at the top and
 * newest at the bottom next to the box, scrolled to the newest as answers come. Collapses to a slim "Ask" strip with
 * the count of answers; the choice is remembered on this Mac (open by default). The host's Ask button and ⌘J
 * (oleAskTakesOver) open it when collapsed and focus the box. Same rules as the dock: this note's call only, and
 * not while live context is blocked.
 */
export function OleAskColumn({ state, meetingId }: { state: OleLiveState; meetingId: string }) {
  const box = useAskBox(state, meetingId)
  const [collapsed, setCollapsed] = useState(() => readAskColumnCollapsed())
  const list = useRef<HTMLUListElement>(null)
  const strip = useRef<HTMLButtonElement>(null)
  /** what gets focus after the next render: the box once the column opens, the strip once it collapses */
  const focusNext = useRef<'input' | 'strip' | null>(null)
  const isCollapsed = useRef(collapsed)
  isCollapsed.current = collapsed
  const { input, blocked } = box
  const mine = state.meetingId === meetingId
  const open = () => {
    focusNext.current = 'input'
    if (isCollapsed.current) { isCollapsed.current = false; writeAskColumnCollapsed(false); setCollapsed(false) }
    input.current?.focus()
  }
  const collapse = () => { focusNext.current = 'strip'; isCollapsed.current = true; writeAskColumnCollapsed(true); setCollapsed(true) }
  useEffect(() => {
    if (blocked || !mine) return
    return registerOleAskDock(meetingId, open)
  }, [meetingId, blocked, mine])
  useEffect(() => {
    const next = focusNext.current === 'input' ? input.current : focusNext.current === 'strip' ? strip.current : null
    if (next) { focusNext.current = null; next.focus() }
  })
  const answers = state.answers ?? []
  const newest = answers[0]
  useEffect(() => {
    const el = list.current
    if (!el) return
    let behavior: ScrollBehavior = 'auto'
    try { behavior = scrollBehavior() } catch { /* no matchMedia: jump */ }
    el.scrollTo?.({ top: el.scrollHeight, behavior })
  }, [answers.length, newest?.id, newest?.pending, collapsed])
  if (blocked || !mine) return null
  if (collapsed) return <aside data-testid="ole-ask-strip" aria-label="Ask Ole" className="flex shrink-0 flex-col items-center border-s border-line bg-bg pt-3" style={{ width: ASK_STRIP_WIDTH }}>
    <button ref={strip} data-testid="ole-ask-expand" aria-expanded={false} title="Open Ask"
      aria-label={answers.length ? `Open Ask, ${answers.length} ${answers.length === 1 ? 'answer' : 'answers'}` : 'Open Ask'}
      className="flex flex-col items-center gap-2 rounded-md px-1 py-2 text-[12px] font-medium text-muted hover:text-ink" onClick={open}>
      <span style={{ writingMode: 'vertical-rl' }}>Ask</span>
      {answers.length > 0 && <span data-testid="ole-ask-strip-count" aria-hidden="true" className="rounded-full px-1.5 text-[10px] leading-[16px] font-semibold"
        style={{ minWidth: 16, textAlign: 'center', background: 'var(--accent)', color: 'var(--bg)' }}>{answers.length > 99 ? '99+' : answers.length}</span>}
    </button>
  </aside>
  return <aside data-testid="ole-ask-column" aria-label="Ask Ole" className="flex min-h-0 shrink-0 flex-col border-s border-line bg-bg" style={{ width: ASK_COLUMN_WIDTH }}>
    <div className="flex items-start justify-between gap-2 px-3 pt-3 pb-2">
      <div className="min-w-0">
        <h2 className="text-[13px] leading-[18px] font-semibold">Ask</h2>
        <p data-testid="ole-ask-label" className="text-[11px] leading-[16px] text-muted">{OLE_ASK_LABEL}</p>
      </div>
      <button data-testid="ole-ask-collapse" aria-expanded={true} aria-label="Collapse Ask" title="Collapse Ask" className="workspace-button shrink-0" onClick={collapse}>
        <PanelRightClose size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
    <ul ref={list} data-testid="ole-ask-answers" role="list" className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 pb-2" style={{ overscrollBehavior: 'contain' }}>
      {shownAnswers(answers, true).map(a => <AnswerItem key={a.id} a={a} />)}
    </ul>
    <div className="border-t border-line px-3 py-2">{askRow(box)}</div>
  </aside>
}
