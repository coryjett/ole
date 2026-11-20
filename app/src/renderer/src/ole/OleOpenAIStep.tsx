// Ole: the first-run screens for OpenAI and the MCP servers (#29). Each is shown after the welcome only when it isn't
// set up yet, and each offers the same checks as Settings: the OpenAI key's Test (key works, models on the account),
// and for servers the very component Settings uses (Test with its badge, Show tools).
import { useState, type ReactNode } from 'react'
import type { OpenAITestResult } from '../../../main/ole/openaiTest'
import { OleServers, type OleSettingsApi } from './OleSettings'

export type OleOpenAIStepApi = {
  setSecret(name: 'openai', value: string): Promise<unknown>
  testOpenAI(): Promise<OpenAITestResult>
  /** Local providers the person never chose become OpenAI (#10) */
  adoptOpenAI(): Promise<unknown>
}

/** Onboarding's Layout, passed in so this screen looks like every other first-run screen */
export type OleLayout = (p: { testId: string; step?: string; motionKey: string; art: ReactNode; title: string; text: string; actions: ReactNode; note?: ReactNode }) => ReactNode

/** Saves and tests the key; with useForAll, switches transcription and summaries to OpenAI once the key works */
export async function saveOpenAIKey(api: OleOpenAIStepApi, key: string, useForAll: boolean): Promise<OpenAITestResult> {
  const k = key.trim()
  if (!k) return { ok: false, error: 'Paste a key first' }
  try {
    await api.setSecret('openai', k)
    const r = await api.testOpenAI()
    if (!r.ok) return { ok: false, error: r.error || "That key didn't work" }
    if (useForAll) await api.adoptOpenAI()
    return r
  } catch {
    return { ok: false, error: "Couldn't save the key" }
  }
}

const modelLine = (m?: { name: string; found: boolean }) => !m ? '' : m.found ? `${m.name} available` : `${m.name} not on this account`

/** the same result line as Settings' OpenAI Test */
export function openAIResultText(r: OpenAITestResult): string {
  return r.ok ? ['✓ Key works', modelLine(r.chatModel), modelLine(r.transcribeModel)].filter(Boolean).join(' · ') : `✕ ${r.error || 'Test failed'}`
}

const field = { width: '100%', height: 36, padding: '0 10px', boxSizing: 'border-box' as const, border: '1px solid var(--line)', borderRadius: 6, background: 'var(--bg)', color: 'var(--ink)', fontSize: 13 }

export function OleOpenAIStep({ api, Layout, art, onNext }: { api: OleOpenAIStepApi; Layout: OleLayout; art: ReactNode; onNext(): void }) {
  const [key, setKey] = useState('')
  const [useForAll, setUseForAll] = useState(true)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<OpenAITestResult | null>(null)
  const save = async () => {
    if (!key.trim() || busy) return
    setBusy(true); setResult(null)
    const r = await saveOpenAIKey(api, key, useForAll)
    setBusy(false); setResult(r)
    if (r.ok) setKey('')
  }
  const retest = async () => { setBusy(true); try { setResult(await api.testOpenAI()) } catch { setResult({ ok: false, error: 'Test failed' }) } finally { setBusy(false) } }
  const saved = !!result?.ok
  return Layout({
    testId: 'onboarding-step', step: 'openai', motionKey: 'openai', art,
    title: 'Connect OpenAI',
    text: 'Ole uses OpenAI to prepare a briefing before each call and to show context while you talk. Paste an API key from platform.openai.com. You can add or change it later in Settings.',
    actions: <div className="flex w-full flex-col gap-3 no-drag">
      {!saved && <>
        <input data-testid="ole-onboarding-openai-key" type="password" autoComplete="off" spellCheck={false} placeholder="sk-…" value={key}
          onChange={e => setKey(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void save() }} style={field} />
        <label className="flex items-center gap-2 text-[13px]">
          <input data-testid="ole-onboarding-openai-all" type="checkbox" checked={useForAll} onChange={e => setUseForAll(e.target.checked)} />
          Also use OpenAI for transcription and summaries
        </label>
      </>}
      <div className="flex gap-2">
        {saved
          ? <><button data-testid="ole-onboarding-openai-continue" className="ob-button primary" onClick={onNext}>Continue</button>
            <button data-testid="ole-onboarding-openai-test" className="ob-button quiet" disabled={busy} onClick={() => void retest()}>{busy ? 'Testing…' : 'Test again'}</button></>
          : <><button data-testid="ole-onboarding-openai-save" className="ob-button primary" disabled={!key.trim() || busy} onClick={() => void save()}>{busy ? 'Testing…' : 'Save and test'}</button>
            <button data-testid="step-later" className="ob-button quiet" onClick={onNext}>Not now</button></>}
      </div>
    </div>,
    note: result ? <p data-testid="ole-onboarding-openai-result" role={result.ok ? 'status' : 'alert'} className="ob-text" style={{ color: result.ok ? '#3fb950' : '#e5484d' }}>{openAIResultText(result)}</p> : undefined,
  })
}

/** First run: add an MCP server, with the same list, Test, badge and Show tools as Settings (#29) */
export function OleServersStep({ api, Layout, art, onNext }: {
  api: Pick<OleSettingsApi, 'getServers' | 'setServers' | 'testServer' | 'setSecret' | 'secretStatus'>; Layout: OleLayout; art: ReactNode; onNext(): void
}) {
  return Layout({
    testId: 'onboarding-step', step: 'mcp-servers', motionKey: 'mcp-servers', art,
    title: 'Add your MCP server',
    text: 'Ole looks things up on your MCP servers to prepare you for calls and to add context while you talk. Add one with its address and key, then press Test. You can add more later in Settings.',
    actions: <div className="flex w-full flex-col gap-3 no-drag">
      <div style={{ maxHeight: 340, overflowY: 'auto' }}><OleServers api={api} /></div>
      <div className="flex gap-2">
        <button data-testid="ole-onboarding-servers-continue" className="ob-button primary" onClick={onNext}>Continue</button>
        <button data-testid="step-later" className="ob-button quiet" onClick={onNext}>Not now</button>
      </div>
    </div>,
  })
}
