// Ole: ask a question during the call (#53, #122). The answer comes from the briefing, the call so far and, when
// needed, a read-only lookup; each answer names its source and links it when Ole has the link.
import { useEffect, useRef, useState } from 'react'
import type { OleAnswer } from '../../../main/ole/core/types'
import type { OleLiveState } from '../../../shared/types'
import { SourceName } from './OleBullets'
import { newAskRequestId, registerOleAskDock, shownAnswers } from './oleAskDock'

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

/**
 * Ole's Ask during a call (#122): the call's answers above a question box, newest nearest the box, only the latest
 * unless "Show N earlier" is open; Stop while answering. docked: fixed at the bottom of the call's note page, where
 * the host's Ask button and ⌘J focus it (oleAskTakesOver); not shown while live context is blocked, so the host's
 * Ask answers then. Home's call panel shows it undocked.
 */
export function OleAskPanel({ state, docked = false, meetingId, defaultExpanded = false }: { state: OleLiveState; docked?: boolean; meetingId?: string; defaultExpanded?: boolean }) {
  const [q, setQ] = useState('')
  const [running, setRunning] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(defaultExpanded)
  const input = useRef<HTMLInputElement>(null)
  const blocked = !!state.blocked
  useEffect(() => {
    if (!docked || !meetingId || blocked) return
    return registerOleAskDock(meetingId, () => { input.current?.focus(); input.current?.scrollIntoView?.({ block: 'nearest' }) })
  }, [docked, meetingId, blocked])
  if (docked && blocked) return null
  const answers = state.answers ?? []
  const shown = shownAnswers(answers, expanded)
  const earlier = answers.length - 1
  const ask = () => {
    const question = q.trim()
    if (!question || running || blocked) return
    const rid = newAskRequestId()
    setRunning(rid); setQ('')
    const done = () => setRunning(r => r === rid ? null : r)
    try { void window.yogurt.ole.ask(question, rid).then(done, done) } catch { done() }
  }
  const stop = () => {
    if (!running) return
    try { void window.yogurt.ole.cancelAsk(running).catch(() => {}) } catch { /* the answer is dropped when it comes */ }
    setRunning(null)
    input.current?.focus()
  }
  return <section data-testid={docked ? 'ole-ask-dock' : 'ole-ask'} aria-label="Ask Ole" className={docked ? 'note-page-width' : 'mt-2'} style={docked ? { paddingTop: 8 } : undefined}>
    {earlier > 0 && <button data-testid="ole-ask-earlier" className="text-action text-[12px]" aria-expanded={expanded} onClick={() => setExpanded(e => !e)}>
      {expanded ? 'Show only the latest' : `Show ${earlier} earlier`}</button>}
    {shown.length > 0 && <ul data-testid="ole-ask-answers" role="list" className="mb-1 flex flex-col gap-1"
      style={expanded ? { maxHeight: '30vh', overflowY: 'auto', overscrollBehavior: 'contain' } : undefined}>
      {shown.map(a => <AnswerItem key={a.id} a={a} />)}
    </ul>}
    <p data-testid="ole-ask-label" className="text-[11px] leading-[16px] text-muted">{OLE_ASK_LABEL}</p>
    <div className="flex items-center gap-1">
      <input ref={input} data-testid="ole-ask-input" className="settings-input w-full" aria-label="Ask Ole about this call" placeholder="Ask Ole about this call…"
        value={q} maxLength={500} disabled={blocked} onChange={e => setQ(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); ask() } }} />
      {q && <button data-testid="ole-ask-clear" aria-label="Clear" className="workspace-button" onClick={() => { setQ(''); input.current?.focus() }}>×</button>}
      {running
        ? <button data-testid="ole-ask-stop" className="workspace-button" onClick={stop}>Stop</button>
        : <button data-testid="ole-ask-send" className="workspace-button" disabled={blocked || !q.trim()} onClick={ask}>Ask</button>}
    </div>
  </section>
}
