// Ole: the call companion panel. Prepare a briefing from the MCP servers before the call (optionally focused on a
// company, person or topic), and the live context bullets while it records.
import { useEffect, useState } from 'react'
import type { OleLiveState } from '../../../shared/types'
import { OleBullets } from './OleBullets'

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
      <button data-testid="ole-prepare" className="workspace-button settings-action" disabled={state.preparing} onClick={prepare}>
        {state.preparing ? 'Preparing…' : state.prepared ? 'Prepare again' : 'Prepare for next call'}</button>
    </div>
    {state.error && <p data-testid="ole-error" role="status" className="settings-description" style={{ color: 'var(--color-danger, #d33)' }}>{state.error}</p>}
    <div className="mt-2">
      <OleBullets bullets={state.bullets} prepared={state.prepared} />
    </div>
  </section>
}
