// Ole: the Settings section for providers, keys and MCP servers. Keys are write-only from here; only masked status comes back.
import { useEffect, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { McpServerConfig, OleProviders, ProviderChoice, SecretName } from '../../../main/ole/types'

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
  testOpenAI(): Promise<import('../../../main/ole/openaiTest').OpenAITestResult>
}

const CHOICES: Array<[ProviderChoice, string]> = [['local', 'Local'], ['openai', 'OpenAI']]
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

export function OpenAIKeyRow({ status, save, test }: { status?: { set: boolean; masked: string }; save: (name: SecretName, value: string) => Promise<boolean>; test: () => Promise<OpenAITest> }) {
  const [result, setResult] = useState<OpenAITest | null>(null)
  const [testing, setTesting] = useState(false)
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
        {result && <TestBadge testId="ole-openai-result" ok={!!result.ok && !missing}
          text={result.ok ? ['Key works', modelLine(result.chatModel), modelLine(result.transcribeModel)].filter(Boolean).join(' · ') : (result.error || 'Test failed')} />}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2">
        <KeyFields name="openai" label="OpenAI key" status={status} save={save} />
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

function ServerRow({ server, status, saveKey, onToggle, onRemove, test }: {
  server: McpServerConfig; status?: { set: boolean; masked: string }
  saveKey: (name: SecretName, value: string) => Promise<boolean>
  onToggle: () => void; onRemove: () => void; test: (id: string) => Promise<ServerTestResult>
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
        <p className="settings-description">A name, and its https address (often ending in /mcp).</p>
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

function ChoiceRow({ id, label, description, value, disabled, onChange }: { id: string; label: string; description: string; value: ProviderChoice; disabled: boolean; onChange: (v: ProviderChoice) => void }) {
  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        <label htmlFor={id} className="settings-label">{label}</label>
        <p className="settings-description">{description}</p>
      </div>
      <span className="settings-select-wrap">
        <select id={id} data-testid={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as ProviderChoice)} className="settings-select">
          {CHOICES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <ChevronDown size={14} aria-hidden="true" />
      </span>
    </div>
  )
}

function ModelRow({ id, label, value, disabled, onSave, maxLength = 100 }: { id: string; label: string; value: string; disabled: boolean; onSave: (v: string) => void; maxLength?: number }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => { if (draft.trim() && draft.trim() !== value) onSave(draft.trim()); else setDraft(value) }
  return (
    <div className="settings-row">
      <label htmlFor={id} className="settings-label settings-row-copy">{label}</label>
      <input id={id} data-testid={id} value={draft} disabled={disabled} spellCheck={false} maxLength={maxLength}
        onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
        className="settings-name-field" />
    </div>
  )
}

const MAX_WARMUP = 8000
const WARMUP_PLACEHOLDER = "How should Ole prepare? e.g. Look up the account for the meeting's company, its open deals and their stage, open support issues, and the last two calls. Lead with risks."

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

export function OleSettings({ api, initialProviders, initialStatus, initialServers }: { api: OleSettingsApi; initialProviders?: OleProviders; initialStatus?: SecretStatus; initialServers?: McpServerConfig[] }) {
  const [providers, setProviders] = useState<OleProviders | undefined>(initialProviders)
  const [status, setStatus] = useState<SecretStatus | undefined>(initialStatus)
  const [servers, setServerList] = useState<McpServerConfig[] | undefined>(initialServers)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!initialProviders) void api.getProviders().then(setProviders).catch(() => setError('Could not load Ole settings'))
    if (!initialStatus) void api.secretStatus().then(setStatus).catch(() => setError('Could not load Ole settings'))
    if (!initialServers) void api.getServers().then(setServerList).catch(() => setError('Could not load Ole settings'))
  }, [api])

  const patch = (p: Partial<OleProviders>) => {
    setError('')
    void api.setProviders(p).then(setProviders).catch(() => setError('Could not save the setting'))
  }
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

  const off = !providers
  return (
    <>
      <h2 className="settings-section-heading">Ole</h2>
      <div data-testid="ole-settings" className="settings-group">
        <ChoiceRow id="ole-transcription" label="Transcription" description="Who turns meeting audio into text."
          value={providers?.transcription ?? 'local'} disabled={off} onChange={(v) => patch({ transcription: v })} />
        <ChoiceRow id="ole-assistant" label="Assistant" description="Who writes notes and answers questions. Anthropic and Vertex: coming later"
          value={providers?.assistant ?? 'local'} disabled={off} onChange={(v) => patch({ assistant: v })} />
        <ModelRow id="ole-transcribe-model" label="OpenAI transcription model" value={providers?.openaiTranscribeModel ?? ''} disabled={off}
          onSave={(v) => patch({ openaiTranscribeModel: v })} />
        <ModelRow id="ole-chat-model" label="OpenAI chat model" value={providers?.openaiChatModel ?? ''} disabled={off}
          onSave={(v) => patch({ openaiChatModel: v })} />
        <OpenAIKeyRow status={status?.openai} save={saveKey} test={() => api.testOpenAI()} />
      </div>
      <h3 className="settings-section-heading">MCP servers</h3>
      <div data-testid="ole-servers" className="settings-group">
        {servers?.length === 0 && <div className="settings-row"><p className="settings-description">No MCP servers yet. Add one below; the assistant finds its tools by itself.</p></div>}
        {servers?.map((s) => (
          <ServerRow key={s.id} server={s} status={status?.[`mcp:${s.id}`]} saveKey={saveKey} test={(id) => api.testServer(id)}
            onToggle={() => toggleServer(s.id)} onRemove={() => removeServer(s.id)} />
        ))}
        {(servers?.length ?? 0) < MAX_SERVERS && <AddServer disabled={!servers} onAdd={addServer} />}
      </div>
      <h3 className="settings-section-heading">Warm-up instructions</h3>
      <WarmupInstructions value={providers?.warmupInstructions ?? ''} disabled={off} onSave={(v) => patch({ warmupInstructions: v })} />
      {error && <div className="settings-row"><p role="alert" className="settings-description">{error}</p></div>}
    </>
  )
}
