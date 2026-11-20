// Ole: the call companion panel. Prepare a briefing from the MCP servers before the call (optionally focused on a
// company, person or topic), and the live context bullets while it records.
import { useEffect, useState } from 'react'
import type { OleLiveState } from '../../../shared/types'
import { OleBullets } from './OleBullets'
import { BeforeYouJoinStrip, OleBriefing } from './OleBriefing'
import { OleAsk } from './OleAsk'

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
  const [focus, setFocus] = useState('')
  if (!state) return null
  const prepare = () => void window.yogurt.ole.prepare({ focus: focus.trim() || null, meetingTitle: state.prepared?.meetingTitle ?? null })
  return <section data-testid="ole-panel" className="settings-group" style={{ padding: 12, margin: compact ? '8px 0' : '0 0 16px' }} aria-label="Ole">
    <div className="flex flex-wrap items-center gap-2">
      <strong className="text-[13px]">Ole</strong>
      <div className="flex min-w-48 flex-1 items-center gap-1">
        <input data-testid="ole-focus" className="settings-input w-full" placeholder="Focus (optional): a company, person or topic" value={focus}
          maxLength={200} onChange={e => setFocus(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !state.preparing) prepare() }} />
        {focus && <button aria-label="Clear" className="workspace-button" onClick={() => setFocus('')}>×</button>}
      </div>
      {/* during a call it rebuilds the briefing the bullets work from, and keeps the bullets (#36) */}
      <button data-testid="ole-prepare" className="workspace-button settings-action" disabled={state.preparing || !!state.blocked} onClick={prepare}
        title={state.meetingId ? 'Rebuilds the briefing for a new focus; bullets so far stay.' : undefined}>
        {state.preparing ? 'Preparing…' : state.meetingId ? 'Refresh briefing' : state.prepared ? 'Prepare again' : 'Prepare for next call'}</button>
    </div>
    {/* a server Ole couldn't use is never skipped silently (#33) */}
    {state.unavailable?.length > 0 && <p data-testid="ole-unavailable" role="alert" className="settings-description" style={{ color: '#e5a50a' }}>
      ⚠ Couldn't use {state.unavailable.map(u => `${u.name} (${u.reason})`).join(', ')}. {state.prepared || state.meetingId ? 'Context from it is missing.' : ''}{' '}
      <button data-testid="ole-retry-servers" className="text-action" onClick={() => void window.yogurt.ole.retryServers()}>Retry</button></p>}
    {state.blocked && <p data-testid="ole-blocked" role="status" className="settings-description">{state.blocked}</p>}
    {state.error && <p data-testid="ole-error" role="status" className="settings-description" style={{ color: 'var(--color-danger, #d33)' }}>{state.error}</p>}
    {/* bullets belong to a call: shown while one records; a finished call keeps them on its note page */}
    {state.meetingId
      ? <LiveView state={state} />
      : <>
        {state.prepared && <p data-testid="ole-prepared" className="settings-description mt-2">Prepared for: {[state.prepared.meetingTitle, state.prepared.focus].filter(Boolean).join(' · ') || 'the next call'}</p>}
        {state.prepared?.text && <OleBriefing key={state.prepared.preparedAt} text={state.prepared.text} defaultOpen />}
      </>}
  </section>
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
    <OleAsk answers={state.answers ?? []} disabled={!!state.blocked} /></>
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
