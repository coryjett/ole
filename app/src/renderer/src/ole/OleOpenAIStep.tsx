// Ole: the first-run screen that connects OpenAI. Shown after the welcome when no key is saved; the key is saved and
// tested in the main process (it never comes back to this window), and "Use OpenAI for transcription and summaries"
// sets both providers to OpenAI.
import { useState, type ReactNode } from 'react'

export type OleOpenAIStepApi = {
  setSecret(name: 'openai', value: string): Promise<unknown>
  testOpenAI(): Promise<{ ok: boolean; error?: string }>
  /** Local providers the person never chose become OpenAI (#10) */
  adoptOpenAI(): Promise<unknown>
}

/** Onboarding's Layout, passed in so this screen looks like every other first-run screen */
export type OleLayout = (p: { testId: string; step?: string; motionKey: string; art: ReactNode; title: string; text: string; actions: ReactNode; note?: ReactNode }) => ReactNode

/** Saves and tests the key; with useForAll, switches transcription and summaries to OpenAI once the key works */
export async function saveOpenAIKey(api: OleOpenAIStepApi, key: string, useForAll: boolean): Promise<{ ok: boolean; error?: string }> {
  const k = key.trim()
  if (!k) return { ok: false, error: 'Paste a key first' }
  try {
    await api.setSecret('openai', k)
    const r = await api.testOpenAI()
    if (!r.ok) return { ok: false, error: r.error || "That key didn't work" }
    if (useForAll) await api.adoptOpenAI()
    return { ok: true }
  } catch {
    return { ok: false, error: "Couldn't save the key" }
  }
}

export function OleOpenAIStep({ api, Layout, art, onNext }: { api: OleOpenAIStepApi; Layout: OleLayout; art: ReactNode; onNext(): void }) {
  const [key, setKey] = useState('')
  const [useForAll, setUseForAll] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = async () => {
    if (!key.trim() || busy) return
    setBusy(true); setError('')
    const r = await saveOpenAIKey(api, key, useForAll)
    setBusy(false)
    if (!r.ok) { setError(r.error ?? "That key didn't work"); return }
    setKey('')
    onNext()
  }
  return Layout({
    testId: 'onboarding-step', step: 'openai', motionKey: 'openai', art,
    title: 'Connect OpenAI',
    text: 'Ole uses OpenAI to prepare a briefing before each call and to show context while you talk. Paste an API key from platform.openai.com. You can add or change it later in Settings.',
    actions: <div className="flex w-full flex-col gap-3 no-drag">
      <input data-testid="ole-onboarding-openai-key" type="password" autoComplete="off" spellCheck={false} placeholder="sk-…" value={key}
        onChange={e => setKey(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void save() }}
        style={{ width: '100%', height: 36, padding: '0 10px', boxSizing: 'border-box', border: '1px solid var(--line)', borderRadius: 6, background: 'var(--bg)', color: 'var(--ink)', fontSize: 13 }} />
      <label className="flex items-center gap-2 text-[13px]">
        <input data-testid="ole-onboarding-openai-all" type="checkbox" checked={useForAll} onChange={e => setUseForAll(e.target.checked)} />
        Also use OpenAI for transcription and summaries
      </label>
      <div className="flex gap-2">
        <button data-testid="ole-onboarding-openai-save" className="ob-button primary" disabled={!key.trim() || busy} onClick={() => void save()}>{busy ? 'Checking…' : 'Save and continue'}</button>
        <button data-testid="step-later" className="ob-button quiet" onClick={onNext}>Not now</button>
      </div>
    </div>,
    note: error ? <p data-testid="ole-onboarding-openai-error" role="alert" className="ob-text" style={{ color: '#e5484d' }}>{error}</p> : undefined,
  })
}
