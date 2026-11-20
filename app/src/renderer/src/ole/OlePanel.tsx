// Ole: the call companion panel. Prepare from Siesta before the call, pick or change the account, and the live
// context bullets while it records.
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
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Array<{ id: string; name: string }>>([])
  const [switching, setSwitching] = useState(false)
  useEffect(() => {
    if (query.trim().length < 2) { setResults([]); return }
    let alive = true
    const timer = setTimeout(() => {
      void window.yogurt.ole.searchAccounts(query.trim()).then(r => { if (alive) setResults(r.slice(0, 8)) }, () => {})
    }, 300)
    return () => { alive = false; clearTimeout(timer) }
  }, [query])
  if (!state) return null
  const pick = (accountId: string | null) => {
    setSwitching(false); setQuery(''); setResults([])
    void window.yogurt.ole.prepare({ accountId, meetingTitle: state.prepared?.meetingTitle ?? null })
  }
  return <section data-testid="ole-panel" className="settings-group" style={{ padding: 12, margin: compact ? '8px 0' : '0 0 16px' }} aria-label="Ole">
    <div className="flex flex-wrap items-center gap-2">
      <strong className="text-[13px]">Ole</strong>
      <button data-testid="ole-prepare" className="workspace-button settings-action" disabled={state.preparing}
        onClick={() => void window.yogurt.ole.prepare({})}>{state.preparing ? 'Preparing…' : state.prepared ? 'Prepare again' : 'Prepare for next call'}</button>
      <button data-testid="ole-switch" className="workspace-button settings-action" onClick={() => setSwitching(v => !v)}>
        {switching ? 'Cancel' : state.prepared?.accountId ? 'Change account' : 'Pick account'}</button>
      {state.prepared?.accountId && <button className="workspace-button settings-action" onClick={() => pick(null)}>Continue without account</button>}
    </div>
    {state.error && <p data-testid="ole-error" role="status" className="settings-description" style={{ color: 'var(--color-danger, #d33)' }}>{state.error}</p>}
    {switching && <div className="mt-2 flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <input data-testid="ole-account-search" className="settings-input" autoFocus placeholder="Search Siesta accounts" value={query} onChange={e => setQuery(e.target.value)} />
        {query && <button aria-label="Clear" className="workspace-button" onClick={() => setQuery('')}>×</button>}
      </div>
      {results.map(r => <button key={r.id} className="text-left text-[13px] underline-offset-2 hover:underline" onClick={() => pick(r.id)}>{r.name}</button>)}
    </div>}
    <div className="mt-2">
      <OleBullets bullets={state.bullets} prepared={state.prepared} />
    </div>
  </section>
}
