// Ole: the call companion panel. Before the call, the next meeting and its briefing (auto-prepared, or "Prepare for…"
// a company, person or topic); during it, the live context bullets and who the call is with (#126).
import { useEffect, useState } from 'react'
import type { OleLiveState } from '../../../shared/types'
import { OleBullets } from './OleBullets'
import { BeforeYouJoinStrip, OleBriefing } from './OleBriefing'
import { OleAskPanel } from './OleAsk'
import { OleCallLists } from './OleCallLists'

/** The live state from the main process, kept current. */
export function useOleState(): OleLiveState | null {
  const [state, setState] = useState<OleLiveState | null>(null)
  useEffect(() => {
    let alive = true
    void window.yogurt.ole.state().then(s => { if (alive) setState(s) }, () => {})
    const off = window.yogurt.ole.onState(s => setState(s))
    return () => { alive = false; off() }
  }, [])
  return state
}

export function OlePanel({ compact = false }: { compact?: boolean }) {
  const state = useOleState()
  if (!state) return null
  return <section data-testid="ole-panel" className="settings-group" style={{ padding: 12, margin: compact ? '8px 0' : '0 0 16px' }} aria-label="Ole">
    <OlePanelHeader state={state} />
    {/* bullets belong to a call: shown while one records; a finished call keeps them on its note page */}
    {state.meetingId ? <LiveView state={state} /> : <OleNextCall state={state} />}
  </section>
}

/**
 * Ole's header, on Home and on the note's Live tab (#108): during a call only Refresh briefing, then who the call is
 * with (#126); what kept a server or the assistant out. No always-visible Focus field: a name goes in "Someone
 * else…" during a call, and in "Prepare for…" on Home.
 */
export function OlePanelHeader({ state }: { state: OleLiveState }) {
  // during a call it rebuilds the briefing the bullets work from, and keeps the bullets (#36)
  const refresh = () => void window.yogurt.ole.prepare({ focus: state.prepared?.focus ?? null, meetingTitle: state.prepared?.meetingTitle ?? null })
  return <>
    <div className="flex flex-wrap items-center gap-2">
      <strong className="text-[13px]">Ole</strong>
      {state.meetingId && <button data-testid="ole-refresh" className="workspace-button settings-action ml-auto" disabled={state.preparing || !!state.blocked} onClick={refresh}
        title="Rebuilds the briefing; bullets so far stay.">{state.preparing ? 'Preparing…' : 'Refresh briefing'}</button>}
    </div>
    {/* a server Ole couldn't use is never skipped silently (#33) */}
    {state.unavailable?.length > 0 && <p data-testid="ole-unavailable" role="alert" className="settings-description" style={{ color: '#e5a50a' }}>
      ⚠ Couldn't use {state.unavailable.map(u => `${u.name} (${u.reason})`).join(', ')}. {state.prepared || state.meetingId ? 'Context from it is missing.' : ''}{' '}
      <button data-testid="ole-retry-servers" className="text-action" onClick={() => void window.yogurt.ole.retryServers()}>Retry</button></p>}
    {state.blocked && <p data-testid="ole-blocked" role="status" className="settings-description">{state.blocked}</p>}
    {state.error && <p data-testid="ole-error" role="status" className="settings-description" style={{ color: 'var(--color-danger, #d33)' }}>{state.error}</p>}
    {state.meetingId && <OleSubject state={state} />}
  </>
}

/** a name input with a clear (X) button; Enter submits. onCleared: the X was pressed with this text in it */
function NameInput({ testId, placeholder, label, onSubmit, onCleared, disabled, submitLabel }: {
  testId: string; placeholder: string; label: string; onSubmit: (name: string) => void; onCleared?: (was: string) => void; disabled?: boolean; submitLabel?: (v: string) => string
}) {
  const [value, setValue] = useState('')
  const submit = () => { if (!disabled) onSubmit(value.trim()) }
  return <div className="flex min-w-48 flex-1 flex-wrap items-center gap-1">
    <input data-testid={testId} className="settings-input min-w-40 flex-1" aria-label={label} placeholder={placeholder} value={value} maxLength={200}
      onChange={e => setValue(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submit() }} />
    {value && <button data-testid={`${testId}-clear`} aria-label="Clear" className="workspace-button" onClick={() => { const was = value.trim(); setValue(''); onCleared?.(was) }}>×</button>}
    {submitLabel && <button data-testid={`${testId}-go`} className="workspace-button settings-action" disabled={disabled} onClick={submit}>{submitLabel(value.trim())}</button>}
  </div>
}

/**
 * During a call: who it is with (#126). Unmatched: says Ole will pick it up from the conversation, offers the names
 * heard from the other side that resolved to a record as one-click chips, and a "Someone else…" input. After a switch,
 * one quiet line. Matched: "Someone else…" stays one click away.
 */
export function OleSubject({ state }: { state: OleLiveState }) {
  const [open, setOpen] = useState(false)
  const candidates = state.subjectCandidates ?? []
  const unmatched = state.matched === false && !state.preparing
  const choose = (name: string) => { if (name) void window.yogurt.ole.chooseSubject(name) }
  const showInput = open || unmatched || candidates.length > 0
  // a wrong match must be easy to see and to fix: say who the briefing is for, with a way to switch (#138)
  const matchedName = state.matched && !state.preparing ? state.matchedName?.trim() : ''
  return <div data-testid="ole-subject" className="mt-1 flex flex-col gap-1 text-[13px]">
    {matchedName && <p data-testid="ole-matched" role="status" className="font-semibold">Briefing for {matchedName}
      {!open && <> <span aria-hidden="true" className="opacity-50">·</span> <button data-testid="ole-not-right" className="text-action text-[12px] font-normal" onClick={() => setOpen(true)}>Not right?</button></>}
    </p>}
    {unmatched && !state.blocked && <p data-testid="ole-unmatched" role="status" className="settings-description">Ole hasn't matched this call yet. It will pick up who it's with from the conversation.</p>}
    {state.subject && <p data-testid="ole-subject-updated" role="status" className="settings-description">Briefing updated for {state.subject.name}</p>}
    <div className="flex flex-wrap items-center gap-2">
      {candidates.length > 0 && <span data-testid="ole-heard" className="flex flex-wrap items-center gap-1">
        <span className="opacity-70">Heard:</span>
        {candidates.map((c, i) => <span key={c.name} className="flex items-center gap-1">
          {i > 0 && <span aria-hidden="true" className="opacity-50">·</span>}
          <button data-testid="ole-heard-chip" className="workspace-button" aria-pressed={state.subject?.name === c.name} disabled={state.preparing || !!state.blocked}
            onClick={() => choose(c.name)}>{c.name}</button>
        </span>)}
      </span>}
      {showInput
        ? <NameInput testId="ole-someone-else" label="Prepare for someone else" placeholder="Someone else…" disabled={state.preparing || !!state.blocked} onSubmit={choose} />
        : matchedName ? null : <button data-testid="ole-someone-else-link" className="text-action text-[12px]" onClick={() => setOpen(true)}>Someone else…</button>}
    </div>
  </div>
}

/** clearing the "Prepare for…" input clears the briefing too when it was prepared with that name (#128) */
export const clearsBriefing = (was: string, prepared: OleLiveState['prepared']) => !!was.trim() && prepared?.focus === was.trim()

const STATE_LABEL = { ready: 'Briefing ready', preparing: 'Preparing…', none: 'No match yet' } as const
const timeOf = (ms: number) => { try { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) } catch { return '' } }

/**
 * Home before a call (#126, #128): the next meeting and its briefing's state, the prepared briefing with a Clear, and
 * a "Prepare for…" link revealing the name input (empty: prepare for the next call).
 */
export function OleNextCall({ state }: { state: OleLiveState }) {
  const [open, setOpen] = useState(false)
  const next = state.nextMeeting ?? null
  const clear = () => void window.yogurt.ole.clearPrepared()
  const prepareFor = (focus: string) => void window.yogurt.ole.prepare({ focus: focus || null, meetingTitle: next?.title ?? state.prepared?.meetingTitle ?? null })
  return <>
    {next && <p data-testid="ole-next" className="settings-description mt-2">Next: {next.title}{timeOf(next.start) ? ` · ${timeOf(next.start)}` : ''}{' '}
      <span data-testid="ole-next-state" className="font-semibold">{state.preparing ? STATE_LABEL.preparing : STATE_LABEL[next.briefing]}</span></p>}
    {!next && state.preparing && <p data-testid="ole-next-state" className="settings-description mt-2">Preparing…</p>}
    {state.prepared && <p data-testid="ole-prepared" className="settings-description mt-2 flex flex-wrap items-center gap-2">
      <span>Prepared for: {[state.prepared.meetingTitle, state.prepared.focus].filter(Boolean).join(' · ') || 'the next call'}</span>
      <button data-testid="ole-prepared-clear" className="workspace-button" onClick={clear}>Clear</button></p>}
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {open
        // clearing the name a briefing was prepared with clears that briefing too (#128)
        ? <NameInput testId="ole-prepare-for" label="Prepare for" placeholder="A company, person or topic (optional)" disabled={state.preparing || !!state.blocked}
          onSubmit={prepareFor} onCleared={was => { if (clearsBriefing(was, state.prepared)) clear() }} submitLabel={v => v ? 'Prepare' : 'Prepare for next call'} />
        : <button data-testid="ole-prepare-for-link" className="text-action text-[12px]" onClick={() => setOpen(true)}>Prepare for…</button>}
    </div>
    {state.prepared?.text && <OleBriefing key={state.prepared.preparedAt} text={state.prepared.text} defaultOpen />}
  </>
}

/** wide enough for bullets and briefing side by side */
const WIDE = '(min-width: 900px)'
function useWide(): boolean {
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(WIDE).matches)
  useEffect(() => {
    const m = window.matchMedia?.(WIDE)
    if (!m) return
    const on = () => setWide(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return wide
}

/**
 * During a call: the briefing and the bullets together (#49). Wide: bullets left with the "Before you join" strip
 * pinned above them, the briefing right, each scrolling on its own. Narrow: tabs, the Live count showing new bullets.
 */
export function LiveView({ state, wideOverride }: { state: OleLiveState; wideOverride?: boolean }) {
  const detected = useWide()
  const wide = wideOverride ?? detected
  const [tab, setTab] = useState<'live' | 'briefing'>('live')
  const text = state.prepared?.text ?? ''
  const bullets = <>{text && <BeforeYouJoinStrip text={text} />}
    <OleBullets bullets={state.bullets} prepared={state.prepared} maxHeight={260}
      onPin={(id, on) => void window.yogurt.ole.pinBullet(id, on)} onRate={(id, r) => void window.yogurt.ole.rateBullet(id, r)} />
    <OleCallLists openQuestions={state.openQuestions} commitments={state.commitments} />
    <OleAskPanel state={state} /></>
  if (!text) return <div className="mt-2">{bullets}</div>
  if (wide) return <div data-testid="ole-live-split" className="mt-2 flex gap-4">
    <div style={{ flex: '3 1 0', minWidth: 0 }}>{bullets}</div>
    <div style={{ flex: '2 1 0', minWidth: 0, borderLeft: '1px solid var(--line)', paddingLeft: 16 }}><OleBriefing key={state.prepared!.preparedAt} text={text} defaultOpen maxHeight={260} /></div>
  </div>
  return <div data-testid="ole-live-tabs" className="mt-2">
    <div role="tablist" className="mb-2 flex gap-3 text-[13px]">
      <button role="tab" aria-selected={tab === 'live'} className={tab === 'live' ? 'font-semibold' : 'opacity-70'} onClick={() => setTab('live')}>Live ({state.bullets.length})</button>
      <button role="tab" aria-selected={tab === 'briefing'} className={tab === 'briefing' ? 'font-semibold' : 'opacity-70'} onClick={() => setTab('briefing')}>Briefing</button>
    </div>
    {tab === 'live' ? bullets : <OleBriefing key={state.prepared!.preparedAt} text={text} defaultOpen maxHeight={260} />}
  </div>
}
