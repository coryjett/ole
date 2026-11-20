// Ole: which engine transcribes and which writes notes and answers (Local or OpenAI), with the OpenAI model names and the warm-up instructions.
import { ipcMain } from 'electron'
import { loadSettings, updateSettings, type Settings } from '../settings'
import type { AssistantChoice, OleProviders, ProviderChoice } from './types'
import { readSecret } from './secrets'
import { listOpenAIModels, testOpenAI } from './openaiTest'

type OleProviderSettings = Settings & {
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
  openaiTranscribeModel: 'gpt-4o-mini-transcribe',
  openaiChatModel: 'gpt-5.6-luna',
  openaiPrepareModel: 'gpt-5.6-terra',
  customBaseUrl: '',
  customModel: '',
  prepareOn: 'assistant',
  warmupInstructions: ''
}

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

export function providersOf(s: Settings): OleProviders {
  const settings = s as OleProviderSettings
  const transcription = isProviderChoice(settings.oleTranscription) ? settings.oleTranscription : PROVIDER_DEFAULTS.transcription
  const assistant = isAssistantChoice(settings.oleAssistant) ? settings.oleAssistant : PROVIDER_DEFAULTS.assistant

  let openaiTranscribeModel = (settings.oleTranscribeModel ?? '').trim()
  if (!isValidModelName(openaiTranscribeModel)) {
    openaiTranscribeModel = PROVIDER_DEFAULTS.openaiTranscribeModel
  }

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

  return { transcription, assistant, openaiTranscribeModel, openaiChatModel, openaiPrepareModel, warmupInstructions, customBaseUrl, customModel, prepareOn }
}

export function setProviders(file: string, patch: unknown): OleProviders {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return providersOf(loadSettings(file))

  const p = patch as Partial<OleProviders>
  const settingsPatch: Partial<OleProviderSettings> = {}

  // a dropdown the person changed is their choice: the OpenAI key never switches it again (#10)
  const auto = new Set(loadSettings(file).oleAutoSwitched ?? [])
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
  if ('openaiTranscribeModel' in p) {
    const model = typeof p.openaiTranscribeModel === 'string' ? p.openaiTranscribeModel.trim() : ''
    if (isValidModelName(model)) {
      settingsPatch.oleTranscribeModel = model
    }
  }
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

  if ('warmupInstructions' in p && typeof p.warmupInstructions === 'string') {
    const text = warmupOf(p.warmupInstructions)
    settingsPatch.oleWarmupInstructions = text === '' ? undefined : text
  }

  return providersOf(updateSettings(file, settingsPatch as Partial<Settings>))
}

type Kind = 'transcription' | 'assistant'
const KINDS: Kind[] = ['transcription', 'assistant']
const keyOf = (k: Kind) => k === 'transcription' ? 'oleTranscription' : 'oleAssistant'
const chosenOf = (k: Kind) => k === 'transcription' ? 'oleTranscriptionChosen' : 'oleAssistantChosen'

/** a working OpenAI key was saved: Local providers the person never chose become OpenAI (#10) */
export function adoptOpenAI(file: string): { switched: Kind[]; providers: OleProviders } {
  const s = loadSettings(file)
  const now = providersOf(s)
  const switched = KINDS.filter(k => now[k] === 'local' && !s[chosenOf(k)])
  if (!switched.length) return { switched, providers: now }
  const patch: Partial<Settings> = { oleAutoSwitched: [...new Set([...(s.oleAutoSwitched ?? []), ...switched])] }
  for (const k of switched) patch[keyOf(k)] = 'openai'
  return { switched, providers: providersOf(updateSettings(file, patch)) }
}

/** what the key switched goes back to Local; undo also records Local as the person's choice */
export function revertOpenAI(file: string, o: { undo: boolean }): { reverted: Kind[]; providers: OleProviders } {
  const s = loadSettings(file)
  const reverted = (s.oleAutoSwitched ?? []).filter(k => providersOf(s)[k] === 'openai')
  const patch: Partial<Settings> = { oleAutoSwitched: undefined }
  for (const k of reverted) { patch[keyOf(k)] = 'local'; if (o.undo) patch[chosenOf(k)] = true }
  return { reverted, providers: providersOf(updateSettings(file, patch)) }
}

export function hookOleProviders(d: { file: string }): void {
  ipcMain.handle('ole:providers:get', () => providersOf(loadSettings(d.file)))

  ipcMain.handle('ole:providers:set', (_e, patch: unknown) => setProviders(d.file, patch))

  ipcMain.handle('ole:openai:test', () => {
    const p = providersOf(loadSettings(d.file))
    return testOpenAI({ key: readSecret(d.file, 'openai'), chatModel: p.openaiChatModel, transcribeModel: p.openaiTranscribeModel })
  })
  ipcMain.handle('ole:openai:adopt', () => adoptOpenAI(d.file))
  ipcMain.handle('ole:openai:revert', (_e, undo: unknown) => revertOpenAI(d.file, { undo: undo === true }))
  ipcMain.handle('ole:openai:models', () => listOpenAIModels({ key: readSecret(d.file, 'openai') }))
  // the Custom server (#17): its models, and a reachability and key check
  ipcMain.handle('ole:custom:models', () => {
    const p = providersOf(loadSettings(d.file))
    if (!p.customBaseUrl) return { ok: false, error: 'Add the server address first', chat: [], transcribe: [] }
    return listOpenAIModels({ key: readSecret(d.file, 'custom'), baseUrl: p.customBaseUrl })
  })
  ipcMain.handle('ole:custom:test', () => {
    const p = providersOf(loadSettings(d.file))
    if (!p.customBaseUrl) return { ok: false, error: 'Add the server address first' }
    return testOpenAI({ key: readSecret(d.file, 'custom'), baseUrl: p.customBaseUrl, chatModel: p.customModel, transcribeModel: '' })
  })
}
