// Ole: which engine transcribes and which writes notes and answers (Local or OpenAI), with the OpenAI model names and the
// warm-up instructions. Pure: reads and patches the host's settings through a SettingsStore.
import type { OleSettings, SettingsStore } from './host'
import type { AssistantChoice, OleProviders, ProviderChoice, TranscribeModelSwitch } from './types'
import { TRANSCRIBE_SUCCESSOR, migrateTranscribeModel } from './transcribeModels'

/** as read from a file that may have been edited by hand: any string */
type OleProviderSettings = Omit<OleSettings, 'oleTranscription' | 'oleAssistant' | 'olePrepareOn'> & {
  oleTranscription?: string
  oleAssistant?: string
  oleTranscribeModel?: string
  oleChatModel?: string
  olePrepareModel?: string
  oleCustomBaseUrl?: string
  oleCustomModel?: string
  oleWarmupInstructions?: string
  olePrepareOn?: string
}

export const PROVIDER_DEFAULTS: OleProviders = {
  transcription: 'local',
  assistant: 'local',
  openaiTranscribeModel: TRANSCRIBE_SUCCESSOR,
  transcribeModelSwitched: null,
  openaiStreaming: true,
  openaiChatModel: 'gpt-5.6-luna',
  openaiPrepareModel: 'gpt-5.6-terra',
  customBaseUrl: '',
  customModel: '',
  prepareOn: 'assistant',
  warmupInstructions: '',
  hideWhileSharing: false,
  autoPrepare: true,
  autoPrepareLead: 10,
}

export const AUTO_PREPARE_LEADS = [5, 10, 15] as const

export const MAX_WARMUP_INSTRUCTIONS = 8000

/** trimmed, cut to 8000 characters; anything not a string is '' */
const warmupOf = (v: unknown): string => (typeof v === 'string' ? v.trim().slice(0, MAX_WARMUP_INSTRUCTIONS).trim() : '')

export const isProviderChoice = (v: unknown): v is ProviderChoice => v === 'local' || v === 'openai'
export const isAssistantChoice = (v: unknown): v is AssistantChoice => isProviderChoice(v) || v === 'custom'

/** an https base URL without credentials, at most 300 characters (#17) */
export function isValidBaseUrl(v: string): boolean {
  if (v.length > 300 || /\s/.test(v)) return false
  try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password } catch { return false }
}

function isValidModelName(v: string): boolean {
  if (v.length === 0 || v.length > 100) return false
  return /^[A-Za-z0-9._:-]+$/.test(v)
}

/** the saved transcription model, a retiring one moved to its successor; an invalid or missing one is the default */
function transcribeModelOf(v: unknown): { model: string; switched: TranscribeModelSwitch | null } {
  const m = typeof v === 'string' ? v.trim() : ''
  return isValidModelName(m) ? migrateTranscribeModel(m) : { model: PROVIDER_DEFAULTS.openaiTranscribeModel, switched: null }
}

/** a stored switch notice, or null when it is missing or malformed (the file may have been edited by hand) */
function switchOf(v: unknown): TranscribeModelSwitch | null {
  if (!v || typeof v !== 'object') return null
  const { from, to, retires } = v as Record<string, unknown>
  return typeof from === 'string' && typeof to === 'string' && typeof retires === 'string' && isValidModelName(from) && isValidModelName(to) && /^\d{4}-\d{2}-\d{2}$/.test(retires)
    ? { from, to, retires } : null
}

export function providersOf(s: OleSettings): OleProviders {
  const settings = s as OleProviderSettings
  const transcription = isProviderChoice(settings.oleTranscription) ? settings.oleTranscription : PROVIDER_DEFAULTS.transcription
  const assistant = isAssistantChoice(settings.oleAssistant) ? settings.oleAssistant : PROVIDER_DEFAULTS.assistant

  // a retiring model is read as its successor, and saved that way on the next write (#89)
  const { model: openaiTranscribeModel, switched } = transcribeModelOf(settings.oleTranscribeModel)
  const transcribeModelSwitched = switched ?? switchOf(settings.oleTranscribeModelSwitched)

  let openaiChatModel = (settings.oleChatModel ?? '').trim()
  if (!isValidModelName(openaiChatModel)) {
    openaiChatModel = PROVIDER_DEFAULTS.openaiChatModel
  }

  const warmupInstructions = warmupOf(settings.oleWarmupInstructions)

  let openaiPrepareModel = (settings.olePrepareModel ?? '').trim()
  if (!isValidModelName(openaiPrepareModel)) openaiPrepareModel = PROVIDER_DEFAULTS.openaiPrepareModel

  const base = (settings.oleCustomBaseUrl ?? '').trim()
  const customBaseUrl = isValidBaseUrl(base) ? base : PROVIDER_DEFAULTS.customBaseUrl
  const cm = (settings.oleCustomModel ?? '').trim()
  // '' means whatever the server serves (sent as 'default'); a single-model server ignores the name anyway
  const customModel = isValidModelName(cm) ? cm : PROVIDER_DEFAULTS.customModel

  const prepareOn = settings.olePrepareOn === 'local' ? 'local' as const : 'assistant' as const

  const openaiStreaming = s.oleTranscribeStreaming !== false
  const hideWhileSharing = s.oleHideWhileSharing === true
  const autoPrepare = s.oleAutoPrepare !== false
  const autoPrepareLead = (AUTO_PREPARE_LEADS as readonly number[]).includes(s.oleAutoPrepareLead ?? -1) ? s.oleAutoPrepareLead! : PROVIDER_DEFAULTS.autoPrepareLead

  return { transcription, assistant, openaiTranscribeModel, transcribeModelSwitched, openaiStreaming, openaiChatModel, openaiPrepareModel, warmupInstructions, customBaseUrl, customModel, prepareOn, hideWhileSharing, autoPrepare, autoPrepareLead }
}

export function setProviders(store: SettingsStore, patch: unknown): OleProviders {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return providersOf(store.get())

  const p = patch as Partial<OleProviders>
  const settingsPatch: Partial<OleProviderSettings> = {}

  // a dropdown the person changed is their choice: the OpenAI key never switches it again (#10)
  const auto = new Set(store.get().oleAutoSwitched ?? [])
  if ('transcription' in p && isProviderChoice(p.transcription)) {
    settingsPatch.oleTranscription = p.transcription
    settingsPatch.oleTranscriptionChosen = true
    auto.delete('transcription')
  }
  if ('assistant' in p && isAssistantChoice(p.assistant)) {
    settingsPatch.oleAssistant = p.assistant
    settingsPatch.oleAssistantChosen = true
    auto.delete('assistant')
  }
  if ('transcription' in p || 'assistant' in p) settingsPatch.oleAutoSwitched = auto.size ? [...auto] : undefined
  // a saved retiring model is written back as its successor on any write, and the notice is kept until dismissed (#89)
  const saved = store.get().oleTranscribeModel
  const moved = typeof saved === 'string' && isValidModelName(saved.trim()) ? migrateTranscribeModel(saved.trim()).switched : null
  if (moved) {
    settingsPatch.oleTranscribeModel = moved.to
    settingsPatch.oleTranscribeModelSwitched = moved
  }
  if ('openaiTranscribeModel' in p) {
    const model = typeof p.openaiTranscribeModel === 'string' ? p.openaiTranscribeModel.trim() : ''
    if (isValidModelName(model)) {
      const chosen = migrateTranscribeModel(model)
      settingsPatch.oleTranscribeModel = chosen.model
      // a model the person picks replaces any earlier notice; picking a retiring one still lands on the successor
      settingsPatch.oleTranscribeModelSwitched = chosen.switched ?? undefined
    }
  }
  if ('transcribeModelSwitched' in p && p.transcribeModelSwitched === null) settingsPatch.oleTranscribeModelSwitched = undefined
  if ('customBaseUrl' in p && typeof p.customBaseUrl === 'string') {
    const url = p.customBaseUrl.trim()
    if (url === '' || isValidBaseUrl(url)) settingsPatch.oleCustomBaseUrl = url
  }
  if ('customModel' in p && typeof p.customModel === 'string' && (p.customModel.trim() === '' || isValidModelName(p.customModel.trim()))) settingsPatch.oleCustomModel = p.customModel.trim()
  if ('prepareOn' in p && (p.prepareOn === 'local' || p.prepareOn === 'assistant')) settingsPatch.olePrepareOn = p.prepareOn
  if ('openaiPrepareModel' in p) {
    const model = typeof p.openaiPrepareModel === 'string' ? p.openaiPrepareModel.trim() : ''
    if (isValidModelName(model)) settingsPatch.olePrepareModel = model
  }
  if ('openaiChatModel' in p) {
    const model = typeof p.openaiChatModel === 'string' ? p.openaiChatModel.trim() : ''
    if (isValidModelName(model)) {
      settingsPatch.oleChatModel = model
    }
  }

  if ('openaiStreaming' in p && typeof p.openaiStreaming === 'boolean') settingsPatch.oleTranscribeStreaming = p.openaiStreaming
  if ('hideWhileSharing' in p && typeof p.hideWhileSharing === 'boolean') settingsPatch.oleHideWhileSharing = p.hideWhileSharing
  if ('autoPrepare' in p && typeof p.autoPrepare === 'boolean') settingsPatch.oleAutoPrepare = p.autoPrepare
  if ('autoPrepareLead' in p && (AUTO_PREPARE_LEADS as readonly unknown[]).includes(p.autoPrepareLead)) settingsPatch.oleAutoPrepareLead = p.autoPrepareLead

  if ('warmupInstructions' in p && typeof p.warmupInstructions === 'string') {
    const text = warmupOf(p.warmupInstructions)
    settingsPatch.oleWarmupInstructions = text === '' ? undefined : text
  }

  return providersOf(store.patch(settingsPatch as Partial<OleSettings>))
}

type Kind = 'transcription' | 'assistant'
const KINDS: Kind[] = ['transcription', 'assistant']
const keyOf = (k: Kind) => k === 'transcription' ? 'oleTranscription' : 'oleAssistant'
const chosenOf = (k: Kind) => k === 'transcription' ? 'oleTranscriptionChosen' : 'oleAssistantChosen'

/** a working OpenAI key was saved: Local providers the person never chose become OpenAI (#10) */
export function adoptOpenAI(store: SettingsStore): { switched: Kind[]; providers: OleProviders } {
  const s = store.get()
  const now = providersOf(s)
  const switched = KINDS.filter(k => now[k] === 'local' && !s[chosenOf(k)])
  if (!switched.length) return { switched, providers: now }
  const patch: Partial<OleSettings> = { oleAutoSwitched: [...new Set([...(s.oleAutoSwitched ?? []), ...switched])] }
  for (const k of switched) patch[keyOf(k)] = 'openai'
  return { switched, providers: providersOf(store.patch(patch)) }
}

/** what the key switched goes back to Local; undo also records Local as the person's choice */
export function revertOpenAI(store: SettingsStore, o: { undo: boolean }): { reverted: Kind[]; providers: OleProviders } {
  const s = store.get()
  const reverted = (s.oleAutoSwitched ?? []).filter(k => providersOf(s)[k] === 'openai')
  const patch: Partial<OleSettings> = { oleAutoSwitched: undefined }
  for (const k of reverted) { patch[keyOf(k)] = 'local'; if (o.undo) patch[chosenOf(k)] = true }
  return { reverted, providers: providersOf(store.patch(patch)) }
}
