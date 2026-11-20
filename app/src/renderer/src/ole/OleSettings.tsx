// Ole: the Settings section for providers, keys and MCP servers. Keys are write-only from here; only masked status comes back.
import { MODEL_ADVICE, isRecommended, type ModelRole } from './modelAdvice'
import { useEffect, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import type { AssistantChoice, McpServerConfig, OleProviders, ProviderChoice, SecretName } from '../../../main/ole/core/types'

export type SecretStatus = Partial<Record<SecretName, { set: boolean; masked: string }>>
export type ServerTestResult = { ok: boolean; tools: number; error?: string; toolList?: Array<{ name: string; description: string }> }
export type OleSettingsApi = {
  getProviders(): Promise<OleProviders>
  setProviders(p: Partial<OleProviders>): Promise<OleProviders>
  setSecret(name: SecretName, value: string): Promise<SecretStatus>
  /** masked status for the given names; the OpenAI key and every configured server when left out */
  secretStatus(names?: SecretName[]): Promise<SecretStatus>
  getServers(): Promise<McpServerConfig[]>
  setServers(list: Array<Partial<McpServerConfig> & { name: string; url: string }>): Promise<McpServerConfig[]>
  testServer(id: string): Promise<ServerTestResult>
  /** the saved OpenAI key against OpenAI's model list (#2) */
  testOpenAI(): Promise<import('../../../main/ole/core/openaiTest').OpenAITestResult>
  /** the models the saved key can use (#8) */
  openaiModels(): Promise<import('../../../main/ole/core/openaiTest').OpenAIModels>
  /** after a working key is saved: Local providers the person never chose become OpenAI (#10) */
  /** the Custom server's models and a reachability and key check (#17) */
  customModels(): Promise<import('../../../main/ole/core/openaiTest').OpenAIModels>
  testCustom(): Promise<import('../../../main/ole/core/openaiTest').OpenAITestResult>
  adoptOpenAI(): Promise<{ switched: Array<'transcription' | 'assistant'>; providers: OleProviders }>
  /** undo the switch (undo: true also keeps Local as the person's choice), or put it back when the key is removed */
  revertOpenAI(undo: boolean): Promise<{ reverted: Array<'transcription' | 'assistant'>; providers: OleProviders }>
}

const CHOICES: Array<[ProviderChoice, string]> = [['local', 'Local'], ['openai', 'OpenAI']]
const ASSISTANT_CHOICES: Array<[AssistantChoice, string]> = [['local', 'Local'], ['openai', 'OpenAI'], ['custom', 'Custom server']]
const PREPARE_ON_CHOICES: Array<['assistant' | 'local', string]> = [['assistant', 'Assistant'], ['local', 'This Mac']]
const MAX_SERVERS = 10

/** a secret name made safe for an element id: `mcp:abc` becomes `mcp-abc` */
const slug = (name: SecretName): string => name.replace(':', '-')

function KeyFields({ name, label, status, save }: { name: SecretName; label: string; status?: { set: boolean; masked: string }; save: (name: SecretName, value: string) => Promise<boolean> }) {
  // the draft is only what the person types now; the saved key never comes back to the renderer
  const [draft, setDraft] = useState('')
  const set = !!status?.set
  const id = `ole-key-${slug(name)}`
  const submit = async () => { if (draft && await save(name, draft)) setDraft('') }
  return (
    <div className="flex shrink-0 items-center gap-2">
      <input id={id} data-testid={id} type="password" autoComplete="off" spellCheck={false} aria-label={label}
        placeholder={set ? status!.masked : 'Paste key'} value={draft} onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void submit() }} className="settings-name-field" />
      <button data-testid={`${id}-save`} className="workspace-button" disabled={!draft} onClick={() => void submit()}>Save</button>
      {set && <button data-testid={`${id}-clear`} className="workspace-button" onClick={() => void save(name, '')}>Clear</button>}
    </div>
  )
}

const keyStatusText = (status?: { set: boolean; masked: string }) => status?.set ? `Saved: ${status.masked}` : 'Not set'

/** the green or red result line under a Test button */
function TestBadge({ ok, text, testId }: { ok: boolean; text: string; testId: string }) {
  return <p data-testid={testId} role={ok ? 'status' : 'alert'} className="settings-description"
    style={{ display: 'inline-block', marginTop: 6, padding: '1px 8px', borderRadius: 6, fontSize: 12, fontWeight: 500,
      color: ok ? '#3fb950' : '#ff6b6b', background: ok ? 'rgba(63, 185, 80, 0.12)' : 'rgba(255, 107, 107, 0.12)' }}>
    {ok ? `✓ ${text}` : `✕ ${text}`}</p>
}

type OpenAITest = Awaited<ReturnType<OleSettingsApi['testOpenAI']>>
const modelLine = (m?: { name: string; found: boolean }) => !m ? '' : m.found ? `${m.name} available` : `${m.name} not on this account`

const switchedText = (k: Array<'transcription' | 'assistant'>) => k.length === 2 ? 'transcription and summaries' : k[0] === 'transcription' ? 'transcription' : 'summaries'

export function OpenAIKeyRow({ status, save, test, adopt, revert }: {
  status?: { set: boolean; masked: string }; save: (name: SecretName, value: string) => Promise<boolean>; test: () => Promise<OpenAITest>
  adopt?: () => Promise<{ switched: Array<'transcription' | 'assistant'> }>; revert?: (undo: boolean) => Promise<{ reverted: Array<'transcription' | 'assistant'> }>
}) {
  const [result, setResult] = useState<OpenAITest | null>(null)
  const [testing, setTesting] = useState(false)
  const [notice, setNotice] = useState<{ text: string; undo: boolean } | null>(null)
  // a saved key that works switches Local providers to OpenAI and says so; removing it puts them back (#10)
  const saveKey = async (name: SecretName, value: string) => {
    const ok = await save(name, value)
    if (!ok) return ok
    setNotice(null)
    if (!value) {
      const r = await revert?.(false).catch(() => null)
      if (r?.reverted.length) setNotice({ text: `OpenAI key removed: ${switchedText(r.reverted)} back to Local from the next meeting.`, undo: false })
      return ok
    }
    const t = await test().catch(() => null)
    if (t) setResult(t)
    if (!t?.ok) return ok
    const r = await adopt?.().catch(() => null)
    if (r?.switched.length) setNotice({ text: `Switched ${switchedText(r.switched)} to OpenAI. Your key is used from the next meeting.`, undo: true })
    return ok
  }
  const undo = async () => { await revert?.(true).catch(() => null); setNotice({ text: 'Kept Local. You can change this any time below.', undo: false }) }
  const run = async () => {
    setTesting(true); setResult(null)
    try { setResult(await test()) } catch { setResult({ ok: false, error: 'Test failed' }) } finally { setTesting(false) }
  }
  const missing = result?.ok && [result.chatModel, result.transcribeModel].some(m => m && !m.found)
  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        <label htmlFor="ole-key-openai" className="settings-label">OpenAI key</label>
        <p data-testid="ole-key-openai-status" className="settings-description">{keyStatusText(status)}</p>
        {notice && <p data-testid="ole-openai-switched" role="status" className="settings-description" style={{ marginTop: 6 }}>
          {notice.text}{notice.undo && <> <button data-testid="ole-openai-undo" className="text-action" onClick={() => void undo()}>Undo</button></>}</p>}
        {result && <TestBadge testId="ole-openai-result" ok={!!result.ok && !missing}
          text={result.ok ? ['Key works', modelLine(result.chatModel), modelLine(result.transcribeModel)].filter(Boolean).join(' · ') : (result.error || 'Test failed')} />}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2">
        <KeyFields name="openai" label="OpenAI key" status={status} save={saveKey} />
        <button data-testid="ole-openai-test" className="workspace-button" disabled={testing} onClick={() => void run()}>{testing ? 'Testing…' : 'Test'}</button>
      </div>
    </div>
  )
}

function KeyRow({ name, label, status, save }: { name: SecretName; label: string; status?: { set: boolean; masked: string }; save: (name: SecretName, value: string) => Promise<boolean> }) {
  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        <label htmlFor={`ole-key-${slug(name)}`} className="settings-label">{label}</label>
        <p data-testid={`ole-key-${slug(name)}-status`} className="settings-description">{keyStatusText(status)}</p>
      </div>
      <KeyFields name={name} label={label} status={status} save={save} />
    </div>
  )
}

/** the list with one server moved a place up (-1) or down (1); the same list when it can't move (#98) */
export function moveServer<T extends { id: string }>(list: T[], id: string, by: -1 | 1): T[] {
  const i = list.findIndex((s) => s.id === id)
  const j = i + by
  if (i < 0 || j < 0 || j >= list.length) return list
  const next = [...list]
  ;[next[i], next[j]] = [next[j], next[i]]
  return next
}

function ServerRow({ server, status, saveKey, onToggle, onRemove, test, onUp, onDown }: {
  server: McpServerConfig; status?: { set: boolean; masked: string }
  saveKey: (name: SecretName, value: string) => Promise<boolean>
  onToggle: () => void; onRemove: () => void; test: (id: string) => Promise<ServerTestResult>
  /** move the server a place up or down the order; absent at that end of the list (#98) */
  onUp?: () => void; onDown?: () => void
}) {
  const [result, setResult] = useState<ServerTestResult | null>(null)
  const [testing, setTesting] = useState(false)
  const [showTools, setShowTools] = useState(false)
  const name: SecretName = `mcp:${server.id}`
  const id = `ole-server-${server.id}`
  const runTest = async () => {
    setTesting(true)
    setResult(null)
    try { setResult(await test(server.id)) } catch { setResult({ ok: false, tools: 0, error: 'Test failed' }) } finally { setTesting(false) }
  }
  return (
    <div data-testid={id} className="settings-row">
      <div className="settings-row-copy">
        <p className="settings-label">{server.name}</p>
        <p data-testid={`${id}-url`} className="settings-description">{server.url}</p>
        <p data-testid={`ole-key-${slug(name)}-status`} className="settings-description">Key: {keyStatusText(status)}</p>
        {result && (
          <TestBadge testId={`${id}-result`} ok={result.ok}
            text={result.ok ? `Connected: ${result.tools} read-only ${result.tools === 1 ? 'tool' : 'tools'}` : (result.error || 'Test failed')} />
        )}
        {result?.ok && !!result.toolList?.length && <>
          <button data-testid={`${id}-show-tools`} className="text-action text-[12px]" style={{ display: 'block', marginTop: 4 }} onClick={() => setShowTools(v => !v)}>
            {showTools ? 'Hide tools' : 'Show tools'}</button>
          {showTools && <ul data-testid={`${id}-tools`} className="settings-description" style={{ marginTop: 4, maxHeight: 260, overflowY: 'auto' }}>
            {result.toolList.map(t => <li key={t.name} style={{ marginBottom: 4 }}><code>{t.name}</code>{t.description ? ` · ${t.description.length > 140 ? `${t.description.slice(0, 140)}…` : t.description}` : ''}</li>)}
          </ul>}
        </>}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2">
        <KeyFields name={name} label={`${server.name} key`} status={status} save={saveKey} />
        <div className="flex items-center gap-2">
          <button data-testid={`${id}-enabled`} role="switch" aria-checked={server.enabled} aria-label={`Use ${server.name}`} onClick={onToggle} className="settings-toggle">
            <span className="settings-toggle-knob" />
          </button>
          <button data-testid={`${id}-test`} className="workspace-button" disabled={testing} onClick={() => void runTest()}>{testing ? 'Testing…' : 'Test'}</button>
          <button data-testid={`${id}-up`} className="workspace-button" aria-label={`Move ${server.name} up`} title="Move up" disabled={!onUp} onClick={onUp}>↑</button>
          <button data-testid={`${id}-down`} className="workspace-button" aria-label={`Move ${server.name} down`} title="Move down" disabled={!onDown} onClick={onDown}>↓</button>
          <button data-testid={`${id}-remove`} className="workspace-button" onClick={onRemove}>Remove</button>
        </div>
      </div>
    </div>
  )
}

function AddServer({ disabled, onAdd }: { disabled: boolean; onAdd: (name: string, url: string) => Promise<boolean> }) {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const ready = name.trim() !== '' && /^https:\/\/\S+$/.test(url.trim())
  const submit = async () => { if (ready && await onAdd(name.trim(), url.trim())) { setName(''); setUrl('') } }
  return (
    <div data-testid="ole-server-add" className="settings-row">
      <div className="settings-row-copy">
        <p className="settings-label">Add server</p>
        <p className="settings-description">A name, and its https address (often ending in /mcp). During a call Ole sends each server short search phrases from the conversation, so add only servers you trust with that.</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <input data-testid="ole-server-add-name" aria-label="Server name" placeholder="Name" value={name} maxLength={40} disabled={disabled}
          spellCheck={false} onChange={(e) => setName(e.target.value)} className="settings-name-field" />
        <input data-testid="ole-server-add-url" aria-label="Server URL" placeholder="https://…/mcp" value={url} maxLength={300} disabled={disabled}
          spellCheck={false} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void submit() }} className="settings-name-field" />
        <button data-testid="ole-server-add-save" className="workspace-button" disabled={disabled || !ready} onClick={() => void submit()}>Add</button>
      </div>
    </div>
  )
}

function ChoiceRow<T extends string>({ id, label, description, value, disabled, onChange, choices = CHOICES as unknown as Array<[T, string]> }: { id: string; label: string; description: string; value: T; disabled: boolean; onChange: (v: T) => void; choices?: Array<[T, string]> }) {
  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        <label htmlFor={id} className="settings-label">{label}</label>
        <p className="settings-description">{description}</p>
      </div>
      <span className="settings-select-wrap">
        <select id={id} data-testid={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)} className="settings-select">
          {choices.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <ChevronDown size={14} aria-hidden="true" />
      </span>
    </div>
  )
}

function SwitchRow({ id, label, description, on, disabled, onChange }: { id: string; label: string; description: string; on: boolean; disabled: boolean; onChange: (on: boolean) => void }) {
  return <div className="settings-row">
    <div className="settings-row-copy">
      <p className="settings-label">{label}</p>
      <p className="settings-description">{description}</p>
    </div>
    <button data-testid={id} role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)} className="settings-toggle">
      <span className="settings-toggle-knob" />
    </button>
  </div>
}

/** during and before calls: hide while sharing (#51), and prepare before calendar meetings (#52) */
export function CallRows({ hideWhileSharing, autoPrepare, autoPrepareLead, disabled, patch }: {
  hideWhileSharing: boolean; autoPrepare: boolean; autoPrepareLead: number; disabled: boolean; patch: (p: Partial<OleProviders>) => void
}) {
  return <>
    <SwitchRow id="ole-hide-sharing" label="Hide Ole while sharing your screen" on={hideWhileSharing} disabled={disabled} onChange={(v) => patch({ hideWhileSharing: v })}
      description="While a call records, Ole's windows stay out of screen sharing so the people on the call never see your briefing. macOS can't tell sharing from a screenshot, so Ole can't be screenshotted during calls either. Most call apps honour this; a few may still show it." />
    <SwitchRow id="ole-auto-prepare" label="Prepare before calendar meetings" on={autoPrepare} disabled={disabled} onChange={(v) => patch({ autoPrepare: v })}
      description="Ole writes the briefing shortly before a meeting on your calendar and tells you when it's ready." />
    {autoPrepare && <ChoiceRow id="ole-auto-prepare-lead" label="When" description="How long before the meeting starts."
      choices={[['5', '5 minutes before'], ['10', '10 minutes before'], ['15', '15 minutes before']]} value={String(autoPrepareLead)} disabled={disabled}
      onChange={(v) => patch({ autoPrepareLead: Number(v) })} />}
  </>
}

type OpenAIModelList = Awaited<ReturnType<OleSettingsApi['openaiModels']>>

/** Assistant = Custom server (#17): any OpenAI-compatible server the person runs: its address, key, model and a Test */
export function CustomServerRows({ api, providers, status, saveKey, disabled, patch }: {
  api: Pick<OleSettingsApi, 'customModels' | 'testCustom'>; providers: OleProviders; status?: { set: boolean; masked: string }
  saveKey: (name: SecretName, value: string) => Promise<boolean>; disabled: boolean; patch: (p: Partial<OleProviders>) => void
}) {
  const [url, setUrl] = useState(providers.customBaseUrl)
  const [models, setModels] = useState<OpenAIModelList | null>(null)
  const [result, setResult] = useState<OpenAITest | null>(null)
  const [testing, setTesting] = useState(false)
  useEffect(() => setUrl(providers.customBaseUrl), [providers.customBaseUrl])
  useEffect(() => { if (providers.customBaseUrl) void api.customModels().then(setModels, () => setModels(null)) }, [providers.customBaseUrl, status?.set, status?.masked])
  const run = async () => {
    setTesting(true); setResult(null)
    try { setResult(await api.testCustom()) } catch { setResult({ ok: false, error: 'Test failed' }) } finally { setTesting(false) }
  }
  const options = models?.ok ? ['', ...models.chat] : ['']
  const value = options.includes(providers.customModel) ? providers.customModel : providers.customModel
  return <>
    <div className="settings-row">
      <div className="settings-row-copy" style={{ flex: 1, minWidth: 0 }}>
        <label htmlFor="ole-custom-url" className="settings-label">Custom server address</label>
        <p className="settings-description">An OpenAI-compatible endpoint you run, ending at /v1 (https). Used for Prepare, live context and summaries; transcription stays Local or OpenAI.</p>
        <input id="ole-custom-url" data-testid="ole-custom-url" value={url} disabled={disabled} spellCheck={false} maxLength={300} placeholder="https://models.example.com/v1"
          onChange={(e) => setUrl(e.target.value)} onBlur={() => { if (url.trim() !== providers.customBaseUrl) patch({ customBaseUrl: url.trim() }) }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
          style={{ display: 'block', width: '100%', height: 32, marginTop: 8, padding: '0 10px', boxSizing: 'border-box', border: '1px solid var(--line)', borderRadius: 6, background: 'var(--bg)', color: 'var(--ink)', fontSize: 13 }} />
        {url.trim() && !/^https:\/\/[^\s]+$/.test(url.trim()) && <p role="alert" className="settings-description" style={{ color: '#ff6b6b' }}>Use an https address.</p>}
      </div>
    </div>
    <div className="settings-row">
      <div className="settings-row-copy">
        <label htmlFor="ole-key-custom" className="settings-label">Custom server key</label>
        <p data-testid="ole-key-custom-status" className="settings-description">{status?.set ? `Saved: ${status.masked}` : 'Not set (fine if your server needs none)'}</p>
        {result && <TestBadge testId="ole-custom-result" ok={!!result.ok} text={result.ok ? `Connected${models?.ok ? `: ${models.chat.length} ${models.chat.length === 1 ? 'model' : 'models'}` : ''}` : (result.error || 'Test failed')} />}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2">
        <KeyFields name="custom" label="Custom server key" status={status} save={saveKey} />
        <button data-testid="ole-custom-test" className="workspace-button" disabled={testing || !providers.customBaseUrl} onClick={() => void run()}>{testing ? 'Testing…' : 'Test'}</button>
      </div>
    </div>
    <div className="settings-row">
      <div className="settings-row-copy">
        <label htmlFor="ole-custom-model" className="settings-label">Custom server model</label>
        <p className="settings-description">Leave on "Server default" for a server that runs one model. It must support tool calls for Prepare and live context.</p>
        {models && !models.ok && <p className="settings-description">{models.error}</p>}
      </div>
      <span className="settings-select-wrap">
        <select id="ole-custom-model" data-testid="ole-custom-model" value={value} disabled={disabled} onChange={(e) => patch({ customModel: e.target.value })} className="settings-select">
          {(options.includes(value) ? options : [value, ...options]).map(m => <option key={m || 'default'} value={m}>{m || 'Server default'}</option>)}
        </select>
        <ChevronDown size={14} aria-hidden="true" />
      </span>
    </div>
  </>
}

/** a model dropdown filled from the key's model list; the saved value always stays selectable (#8) */
export function ModelSelect({ id, label, hint, role, value, options, note, disabled, onChange }: {
  id: string; label: string; hint: string; role: ModelRole; value: string; options?: string[]; note?: string; disabled: boolean; onChange: (v: string) => void
}) {
  const list = options ?? []
  const missing = !!value && list.length > 0 && !list.includes(value)
  const all = value && !list.includes(value) ? [value, ...list] : list
  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        <label htmlFor={id} className="settings-label">{label}</label>
        <p className="settings-description">{hint}</p>
        <p data-testid={`${id}-advice`} className="settings-description">{MODEL_ADVICE[role]}</p>
        {missing && <p data-testid={`${id}-missing`} role="alert" className="settings-description" style={{ color: '#ff6b6b' }}>{value} isn't available to this key</p>}
        {!list.length && note && <p data-testid={`${id}-note`} className="settings-description">{note}</p>}
      </div>
      <span className="settings-select-wrap">
        <select id={id} data-testid={id} value={value} disabled={disabled || all.length === 0} onChange={(e) => onChange(e.target.value)} className="settings-select">
          {all.map(m => <option key={m} value={m}>{isRecommended(role, m) ? `${m} (recommended)` : m}</option>)}
        </select>
        <ChevronDown size={14} aria-hidden="true" />
      </span>
    </div>
  )
}


const MAX_WARMUP = 8000
const WARMUP_PLACEHOLDER = "How should Ole prepare? For example: Sales: the account, its open deals and the last two calls, risks first. Support: the customer's open tickets and recent incidents. Recruiting: the candidate's profile, feedback so far and the role's must-haves."

function WarmupInstructions({ value, disabled, onSave }: { value: string; disabled: boolean; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => { if (draft.trim() !== value) onSave(draft.trim()); else setDraft(value) }
  return (
    <div className="settings-group">
      <div className="settings-row">
        <div className="settings-row-copy" style={{ flex: 1, minWidth: 0 }}>
          <p className="settings-description">Sent to the model each time Ole prepares for a call. An MCP server's own prepare_for_meeting instructions come first; yours refine them.</p>
          {/* not .settings-name-field: that is a one-line field with a fixed width and height */}
          <textarea id="ole-warmup" data-testid="ole-warmup" aria-label="Warm-up instructions" rows={8} maxLength={MAX_WARMUP}
            placeholder={WARMUP_PLACEHOLDER} value={draft} disabled={disabled} onChange={(e) => setDraft(e.target.value)} onBlur={commit}
            style={{ display: 'block', width: '100%', minHeight: 150, marginTop: 10, padding: '8px 10px', boxSizing: 'border-box', resize: 'vertical',
              border: '1px solid var(--line)', borderRadius: 6, background: 'var(--bg)', color: 'var(--ink)', fontSize: 13, lineHeight: '19px', fontFamily: 'inherit' }} />
          <p data-testid="ole-warmup-count" className="settings-description" style={{ textAlign: 'right' }}>{draft.length} / {MAX_WARMUP}</p>
        </div>
      </div>
    </div>
  )
}

/**
 * The MCP servers list with Add server, and per server its key, Test (badge and Show tools), switch and Remove. One
 * component for Settings and first-run setup, so both offer exactly the same checks (#29).
 */
export function OleServers({ api, initialServers, initialStatus, note }: {
  api: Pick<OleSettingsApi, 'getServers' | 'setServers' | 'testServer' | 'setSecret' | 'secretStatus'>
  initialServers?: McpServerConfig[]; initialStatus?: SecretStatus; note?: ReactNode
}) {
  const [servers, setServerList] = useState<McpServerConfig[] | undefined>(initialServers)
  const [status, setStatus] = useState<SecretStatus | undefined>(initialStatus)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!initialServers) void api.getServers().then(setServerList).catch(() => setError('Could not load the servers'))
    if (!initialStatus) void api.secretStatus().then(setStatus).catch(() => {})
  }, [api])
  const saveKey = async (name: SecretName, value: string) => {
    setError('')
    try { const next = await api.setSecret(name, value); setStatus((s) => ({ ...s, ...next })); return true } catch { setError('Could not save the key'); return false }
  }
  const saveServers = async (list: Array<Partial<McpServerConfig> & { name: string; url: string }>) => {
    setError('')
    try {
      const next = await api.setServers(list)
      setServerList(next)
      // a removed server's key is gone and an added one has none yet: ask again for exactly these names
      setStatus(await api.secretStatus(['openai', ...next.map((s) => `mcp:${s.id}` as SecretName)]))
      return true
    } catch { setError('Could not save the servers'); return false }
  }
  const addServer = (name: string, url: string) => saveServers([...(servers ?? []), { name, url, enabled: true }])
  const toggleServer = (id: string) => void saveServers((servers ?? []).map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)))
  const removeServer = (id: string) => void saveServers((servers ?? []).filter((s) => s.id !== id))
  // the order is the priority for meetings (#98): saved as the order of the list
  const move = (id: string, by: -1 | 1) => void saveServers(moveServer(servers ?? [], id, by))
  return (
    <div data-testid="ole-servers" className="settings-group">
      {note && <div className="settings-row">{note}</div>}
      {servers?.length === 0 && <div className="settings-row"><p className="settings-description">No MCP servers yet. Add one below; the assistant finds its tools by itself.</p></div>}
      {(servers?.length ?? 0) > 1 && <div className="settings-row"><p data-testid="ole-servers-order" className="settings-description">Order matters: the first server that knows a meeting supplies its context and the meeting list.</p></div>}
      {servers?.map((s, i) => (
        <ServerRow key={s.id} server={s} status={status?.[`mcp:${s.id}`]} saveKey={saveKey} test={(id) => api.testServer(id)}
          onToggle={() => toggleServer(s.id)} onRemove={() => removeServer(s.id)}
          onUp={i > 0 ? () => move(s.id, -1) : undefined} onDown={i < servers.length - 1 ? () => move(s.id, 1) : undefined} />
      ))}
      {(servers?.length ?? 0) < MAX_SERVERS && <AddServer disabled={!servers} onAdd={addServer} />}
      {error && <div className="settings-row"><p role="alert" className="settings-description">{error}</p></div>}
    </div>
  )
}

export function OleSettings({ api, initialProviders, initialStatus, initialServers }: { api: OleSettingsApi; initialProviders?: OleProviders; initialStatus?: SecretStatus; initialServers?: McpServerConfig[] }) {
  const [providers, setProviders] = useState<OleProviders | undefined>(initialProviders)
  const [status, setStatus] = useState<SecretStatus | undefined>(initialStatus)
  const [error, setError] = useState('')
  const [models, setModels] = useState<OpenAIModelList | undefined>()
  const loadModels = () => void api.openaiModels?.().then(setModels, () => setModels({ ok: false, error: "Couldn't load the model list", chat: [], transcribe: [] }))
  const modelsNote = models && !models.ok ? models.error : models ? undefined : 'Loading your models…'

  useEffect(() => {
    if (!initialProviders) void api.getProviders().then(setProviders).catch(() => setError('Could not load Ole settings'))
    if (!initialStatus) void api.secretStatus().then(setStatus).catch(() => setError('Could not load Ole settings'))
  }, [api])
  // the model list follows the OpenAI key: loaded on open, and again when the key changes
  useEffect(() => { if (status?.openai?.set) loadModels(); else if (status) setModels({ ok: false, error: 'Save an OpenAI key to see your models', chat: [], transcribe: [] }) }, [status?.openai?.set, status?.openai?.masked])

  const patch = (p: Partial<OleProviders>) => {
    setError('')
    void api.setProviders(p).then(setProviders).catch(() => setError('Could not save the setting'))
  }
  const saveKey = async (name: SecretName, value: string) => {
    setError('')
    try { const next = await api.setSecret(name, value); setStatus((s) => ({ ...s, ...next })); return true } catch { setError('Could not save the key'); return false }
  }

  const off = !providers
  return (
    <>
      <h2 className="settings-section-heading">Ole</h2>
      <div data-testid="ole-settings" className="settings-group">
        <ChoiceRow id="ole-transcription" label="Transcription" description="Who turns meeting audio into text."
          value={providers?.transcription ?? 'local'} disabled={off} onChange={(v) => patch({ transcription: v })} />
        {providers?.transcription === 'openai' && <SwitchRow id="ole-transcribe-streaming" label="Live streaming" on={providers.openaiStreaming} disabled={off} onChange={(v) => patch({ openaiStreaming: v })}
          description="Text shows a second or two after it's said, using OpenAI's gpt-live-transcribe; if streaming isn't available, Ole sends audio in chunks with the Transcription model." />}
        <ChoiceRow id="ole-assistant" label="Assistant" description="Who writes notes and answers questions. Prepare and live context need OpenAI or your own server: with Local they are off and your MCP servers are not used. Anthropic and Vertex: coming later"
          choices={ASSISTANT_CHOICES} value={providers?.assistant ?? 'local'} disabled={off} onChange={(v) => patch({ assistant: v })} />
        <ChoiceRow id="ole-prepare-on" label="Prepare runs on" description="Where the briefing before a call is written. This Mac uses the local notes model: private and free, slower, and best with a larger model (around 26B and up); it runs only before a call, never during one. Live context always uses the Assistant."
          choices={PREPARE_ON_CHOICES} value={providers?.prepareOn ?? 'assistant'} disabled={off} onChange={(v) => patch({ prepareOn: v })} />
        {providers?.assistant === 'custom' && <CustomServerRows api={api} providers={providers} status={status?.custom} saveKey={saveKey} disabled={off} patch={patch} />}
        <OpenAIKeyRow status={status?.openai} save={saveKey} test={() => api.testOpenAI()}
          adopt={async () => { const r = await api.adoptOpenAI(); setProviders(r.providers); return r }}
          revert={async (undo) => { const r = await api.revertOpenAI(undo); setProviders(r.providers); return r }} />
        <ModelSelect id="ole-transcribe-model" role="transcribe" label="Transcription model" hint="Turns call audio into text."
          value={providers?.openaiTranscribeModel ?? ''} options={models?.transcribe} note={modelsNote} disabled={off} onChange={(v) => patch({ openaiTranscribeModel: v })} />
        <ModelSelect id="ole-prepare-model" role="prepare" label="Prepare model" hint="Writes the briefing before a call."
          value={providers?.openaiPrepareModel ?? ''} options={models?.chat} note={modelsNote} disabled={off} onChange={(v) => patch({ openaiPrepareModel: v })} />
        <ModelSelect id="ole-chat-model" role="live" label="Live bullets and summaries model" hint="Runs during the call and after it."
          value={providers?.openaiChatModel ?? ''} options={models?.chat} note={modelsNote} disabled={off} onChange={(v) => patch({ openaiChatModel: v })} />
      </div>
      <h3 className="settings-section-heading">Calls</h3>
      <div data-testid="ole-call-settings" className="settings-group">
        <CallRows hideWhileSharing={providers?.hideWhileSharing ?? false} autoPrepare={providers?.autoPrepare ?? true} autoPrepareLead={providers?.autoPrepareLead ?? 10} disabled={off} patch={patch} />
      </div>
      <h3 className="settings-section-heading">MCP servers</h3>
      <OleServers api={api} initialServers={initialServers} initialStatus={initialStatus}
        note={providers?.assistant === 'local' ? <p data-testid="ole-servers-local" role="status" className="settings-description">Used only when Assistant is OpenAI or a Custom server. With Local, Ole doesn't call these servers.</p> : undefined} />
      <h3 className="settings-section-heading">Warm-up instructions</h3>
      <WarmupInstructions value={providers?.warmupInstructions ?? ''} disabled={off} onSave={(v) => patch({ warmupInstructions: v })} />
      {error && <div className="settings-row"><p role="alert" className="settings-description">{error}</p></div>}
    </>
  )
}
