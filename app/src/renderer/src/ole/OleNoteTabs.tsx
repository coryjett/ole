// Ole on the note page as tabs beside Transcript and My notes (#108). During a call: Live (the "Before you join"
// strip, bullets with pin and rate, open questions and commitments, the call's answers) and Briefing. Questions go
// to Ole's Ask: a column on the right of a wide note (#148), else docked at the bottom (#122, OleAsk.tsx). On a saved meeting: Context
// (what Ole kept) and Briefing, each only when Ole has something. Plus the quick-note bar shown during a call.
import { useEffect, useRef, useState } from 'react'
import { BookOpen, MessageSquareText, Radio } from 'lucide-react'
import type { OleAnswer, OleBullet, OleCallMemory } from '../../../main/ole/core/types'
import type { OleLiveState } from '../../../shared/types'
import { OleAnswers } from './OleAsk'
import { BeforeYouJoinStrip, OleBriefing } from './OleBriefing'
import { OleBullets } from './OleBullets'
import { OleCallLists } from './OleCallLists'
import { OlePanelHeader } from './OlePanel'
import { OleExportReplay, OleSavedBulletsView } from './OleSavedBullets'
import { OLE_TAB_LABEL, oleTabs, quickNoteKey, unseenCount, type OleTab } from './oleTabs'

type Saved = { meetingId: string; bullets: OleBullet[]; answers: OleAnswer[]; call: OleCallMemory | null; briefing: string }
export type OleNote = { state: OleLiveState | null; saved: Saved | null; tabs: OleTab[]; unseen: number }

const quiet = <T,>(read: (() => Promise<T>) | undefined, fallback: T): Promise<T> => {
  try { return read ? read().catch(() => fallback) : Promise.resolve(fallback) } catch { return Promise.resolve(fallback) }
}

/**
 * What the note page needs from Ole: the live state, what a saved meeting kept, which tabs exist, and how many
 * bullets came while Live wasn't shown (liveShown: the Live tab is the one on screen).
 */
export function useOleNote(id: string, recording: boolean, liveShown: boolean): OleNote {
  const [state, setState] = useState<OleLiveState | null>(null)
  useEffect(() => {
    const ole = window.yogurt?.ole
    if (!ole?.state) return
    let alive = true
    void quiet(() => ole.state(), null).then(s => { if (alive && s) setState(s) })
    const off = ole.onState?.(s => setState(s))
    return () => { alive = false; off?.() }
  }, [])
  const [saved, setSaved] = useState<Saved | null>(null)
  useEffect(() => {
    if (recording) return
    const ole = window.yogurt?.ole
    if (!ole) return
    let alive = true
    void Promise.all([
      quiet(ole.bullets && (() => ole.bullets(id)), [] as OleBullet[]),
      quiet(ole.answers && (() => ole.answers(id)), [] as OleAnswer[]),
      quiet(ole.call && (() => ole.call(id)), null as OleCallMemory | null),
      quiet(ole.briefing && (() => ole.briefing(id)), ''),
    ]).then(([bullets, answers, call, briefing]) => {
      if (alive) setSaved({ meetingId: id, bullets: bullets ?? [], answers: answers ?? [], call: call ?? null, briefing: briefing ?? '' })
    })
    return () => { alive = false }
  }, [id, recording])
  const seen = useRef<{ id: string; ids: Set<string> }>({ id, ids: new Set() })
  if (seen.current.id !== id) seen.current = { id, ids: new Set() }
  const live = recording && state?.meetingId === id ? state.bullets : []
  useEffect(() => { if (liveShown) for (const b of live) seen.current.ids.add(b.id) })
  const mine = saved?.meetingId === id ? saved : null
  const tabs = oleTabs(recording, mine && {
    bullets: mine.bullets.length, answers: mine.answers.length, briefing: !!mine.briefing.trim(),
    lists: (mine.call?.openQuestions.length ?? 0) + (mine.call?.commitments.length ?? 0),
  })
  // only this note's call: during a call, another meeting's note never sees its bullets or briefing (#113)
  const mineState = recording && state?.meetingId === id ? state : null
  return { state: mineState, saved: mine, tabs, unseen: liveShown ? 0 : unseenCount(live.map(b => b.id), seen.current.ids) }
}

const ICON = { live: Radio, briefing: BookOpen, context: MessageSquareText } as const

/** a tab's icon, name and, on Live, the count of bullets not seen yet */
export function OleTabLabel({ tab, unseen = 0 }: { tab: OleTab; unseen?: number }) {
  const Icon = ICON[tab]
  return <>
    <Icon size={14} strokeWidth={1.75} aria-hidden="true" />{OLE_TAB_LABEL[tab]}
    {unseen > 0 && <span data-testid="note-ole-live-badge" className="rounded-full px-1.5 text-[10px] leading-[16px] font-semibold"
      style={{ minWidth: 16, textAlign: 'center', background: 'var(--accent)', color: 'var(--bg)' }}>
      <span aria-hidden="true">{unseen > 99 ? '99+' : unseen}</span><span className="sr-only">, {unseen} new</span></span>}
  </>
}

/**
 * Live: Prepare and its warnings, the strip, the bullets, the call's lists, every answer from Ask (#122); the page
 * scrolls, nothing is capped. answersInColumn: the Ask column is on screen and lists them, so they aren't twice (#148).
 */
export function OleLiveTab({ state, answersInColumn = false }: { state: OleLiveState; answersInColumn?: boolean }) {
  const text = state.prepared?.text ?? ''
  return <div data-testid="ole-live-tab" className="flex flex-col gap-2">
    <OlePanelHeader state={state} />
    {text && <BeforeYouJoinStrip text={text} />}
    <OleBullets bullets={state.bullets} prepared={state.prepared} maxHeight="none" header={false}
      onPin={(id, on) => void window.yogurt.ole.pinBullet(id, on)} onRate={(id, r) => void window.yogurt.ole.rateBullet(id, r)} />
    <OleCallLists openQuestions={state.openQuestions} commitments={state.commitments} />
    {!answersInColumn && <OleAnswers answers={state.answers ?? []} />}
  </div>
}

function BriefingTab({ text, empty }: { text: string; empty: string }) {
  if (!text.trim()) return <p data-testid="ole-briefing-empty" className="settings-description">{empty}</p>
  return <OleBriefing key={text.length} text={text} defaultOpen maxHeight="none" />
}

/**
 * The tab panel for Ole's tabs. It stays mounted while another tab shows (hidden), so a half-typed question or
 * focus is kept, the way the transcript keeps its place. askColumn: the Ask column is shown beside it (#148).
 */
export function OleTabPanels({ tab, meetingId, recording, ole, askColumn = false }: { tab: OleTab | null; meetingId: string; recording: boolean; ole: OleNote; askColumn?: boolean }) {
  const { state, saved } = ole
  const live = recording && !!state && state.meetingId === meetingId
  return <section data-testid="note-ole-panel" id="note-ole-panel" role="tabpanel" aria-labelledby={tab ? `note-ole-${tab}-tab` : undefined} hidden={!tab}
    className="note-content" style={{ overflowY: 'auto', overscrollBehavior: 'contain' }}>
    <div className="note-page-width" style={{ paddingBlock: '18px 40px' }}>
      {live && <>
        <div hidden={tab !== 'live'}><OleLiveTab state={state} answersInColumn={askColumn} /></div>
        <div hidden={tab !== 'briefing'}><BriefingTab text={state.prepared?.text ?? ''} empty="No briefing for this call yet. Ole picks up who it's with from the conversation; choose a name on the Live tab to prepare now." /></div>
      </>}
      {!recording && saved && <>
        <div hidden={tab !== 'context'}>
          <OleSavedBulletsView bullets={saved.bullets} answers={saved.answers} call={saved.call} />
        </div>
        <div hidden={tab !== 'briefing'}><BriefingTab text={saved.briefing} empty="" /></div>
        {/* a call Ole was part of can be exported for the replay tool (#70): under Context, or Briefing when that is all there is */}
        <div hidden={tab !== (ole.tabs.includes('context') ? 'context' : 'briefing')}><OleExportReplay meetingId={meetingId} /></div>
      </>}
    </div>
  </section>
}

/**
 * During a call: one line under Live, Briefing and Transcript that adds `- [mm:ss] text` to My notes without leaving
 * the tab. onAdd says whether it was added (empty text never is).
 */
export function OleQuickNote({ onAdd }: { onAdd: (text: string) => boolean }) {
  const [text, setText] = useState('')
  const input = useRef<HTMLInputElement>(null)
  return <div data-testid="ole-quick-note" className="note-page-width flex items-center gap-1" style={{ paddingTop: 8 }}>
    <input ref={input} data-testid="ole-quick-note-input" className="settings-input w-full" aria-label="Add a note to My notes" placeholder="Add a note…"
      value={text} maxLength={500} onChange={e => setText(e.target.value)}
      onKeyDown={e => {
        const act = quickNoteKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing })
        if (!act) return
        e.preventDefault()
        if (act === 'leave') e.currentTarget.blur()
        else if (onAdd(text)) setText('')
      }} />
    {text && <button data-testid="ole-quick-note-clear" aria-label="Clear" className="workspace-button" onClick={() => { setText(''); input.current?.focus() }}>×</button>}
  </div>
}
