// Ole: the Settings section for providers and keys. Keys are write-only from here; only masked status comes back.
import { useEffect, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { OleProviders, ProviderChoice, SecretName } from '../../../main/ole/types'

export type SecretStatus = Record<SecretName, { set: boolean; masked: string }>
export type OleSettingsApi = {
  getProviders(): Promise<OleProviders>
  setProviders(p: Partial<OleProviders>): Promise<OleProviders>
  setSecret(name: SecretName, value: string): Promise<SecretStatus>
  secretStatus(): Promise<SecretStatus>
}

const CHOICES: Array<[ProviderChoice, string]> = [['local', 'Local'], ['openai', 'OpenAI']]
const KEYS: Array<[SecretName, string]> = [['openai', 'OpenAI key'], ['mcp', 'MCP server key']]

function KeyRow({ name, label, status, save }: { name: SecretName; label: string; status?: { set: boolean; masked: string }; save: (name: SecretName, value: string) => Promise<boolean> }) {
  // the draft is only what the person types now; the saved key never comes back to the renderer
  const [draft, setDraft] = useState('')
  const set = !!status?.set
  const submit = async () => { if (draft && await save(name, draft)) setDraft('') }
  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        <label htmlFor={`ole-key-${name}`} className="settings-label">{label}</label>
        <p data-testid={`ole-key-${name}-status`} className="settings-description">{set ? `Saved: ${status!.masked}` : 'Not set'}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <input id={`ole-key-${name}`} data-testid={`ole-key-${name}`} type="password" autoComplete="off" spellCheck={false}
          placeholder={set ? status!.masked : 'Paste key'} value={draft} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit() }} className="settings-name-field" />
        <button data-testid={`ole-key-${name}-save`} className="workspace-button" disabled={!draft} onClick={() => void submit()}>Save</button>
        {set && <button data-testid={`ole-key-${name}-clear`} className="workspace-button" onClick={() => void save(name, '')}>Clear</button>}
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

export function OleSettings({ api, initialProviders, initialStatus }: { api: OleSettingsApi; initialProviders?: OleProviders; initialStatus?: SecretStatus }) {
  const [providers, setProviders] = useState<OleProviders | undefined>(initialProviders)
  const [status, setStatus] = useState<SecretStatus | undefined>(initialStatus)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!initialProviders) void api.getProviders().then(setProviders).catch(() => setError('Could not load Ole settings'))
    if (!initialStatus) void api.secretStatus().then(setStatus).catch(() => setError('Could not load Ole settings'))
  }, [api])

  const patch = (p: Partial<OleProviders>) => {
    setError('')
    void api.setProviders(p).then(setProviders).catch(() => setError('Could not save the setting'))
  }
  const saveKey = async (name: SecretName, value: string) => {
    setError('')
    try { setStatus(await api.setSecret(name, value)); return true } catch { setError('Could not save the key'); return false }
  }

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
        <ModelRow id="ole-mcp-url" label="MCP server URL (https://…/mcp)" value={providers?.mcpUrl ?? ''} disabled={off} maxLength={300}
          onSave={(v) => patch({ mcpUrl: v })} />
        {KEYS.map(([name, label]) => <KeyRow key={name} name={name} label={label} status={status?.[name]} save={saveKey} />)}
        {error && <div className="settings-row"><p role="alert" className="settings-description">{error}</p></div>}
      </div>
    </>
  )
}
