// Ole: which engine transcribes and which writes notes and answers (Local or OpenAI), with the OpenAI model names and the warm-up instructions.
import { ipcMain } from 'electron'
import { loadSettings, updateSettings, type Settings } from '../settings'
import type { OleProviders, ProviderChoice } from './types'
import { readSecret } from './secrets'
import { listOpenAIModels, testOpenAI } from './openaiTest'

type OleProviderSettings = Settings & {
  oleTranscription?: string
  oleAssistant?: string
  oleTranscribeModel?: string
  oleChatModel?: string
  olePrepareModel?: string
  oleWarmupInstructions?: string
}

export const PROVIDER_DEFAULTS: OleProviders = {
  transcription: 'local',
  assistant: 'local',
  openaiTranscribeModel: 'gpt-4o-mini-transcribe',
  openaiChatModel: 'gpt-5.6-luna',
  openaiPrepareModel: 'gpt-5.6-terra',
  warmupInstructions: ''
}

export const MAX_WARMUP_INSTRUCTIONS = 8000

/** trimmed, cut to 8000 characters; anything not a string is '' */
const warmupOf = (v: unknown): string => (typeof v === 'string' ? v.trim().slice(0, MAX_WARMUP_INSTRUCTIONS).trim() : '')

export const isProviderChoice = (v: unknown): v is ProviderChoice => v === 'local' || v === 'openai'

function isValidModelName(v: string): boolean {
  if (v.length === 0 || v.length > 100) return false
  return /^[A-Za-z0-9._:-]+$/.test(v)
}

export function providersOf(s: Settings): OleProviders {
  const settings = s as OleProviderSettings
  const transcription = isProviderChoice(settings.oleTranscription) ? settings.oleTranscription : PROVIDER_DEFAULTS.transcription
  const assistant = isProviderChoice(settings.oleAssistant) ? settings.oleAssistant : PROVIDER_DEFAULTS.assistant

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

  return { transcription, assistant, openaiTranscribeModel, openaiChatModel, openaiPrepareModel, warmupInstructions }
}

export function setProviders(file: string, patch: unknown): OleProviders {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return providersOf(loadSettings(file))

  const p = patch as Partial<OleProviders>
  const settingsPatch: Partial<OleProviderSettings> = {}

  if ('transcription' in p && isProviderChoice(p.transcription)) {
    settingsPatch.oleTranscription = p.transcription
  }
  if ('assistant' in p && isProviderChoice(p.assistant)) {
    settingsPatch.oleAssistant = p.assistant
  }
  if ('openaiTranscribeModel' in p) {
    const model = typeof p.openaiTranscribeModel === 'string' ? p.openaiTranscribeModel.trim() : ''
    if (isValidModelName(model)) {
      settingsPatch.oleTranscribeModel = model
    }
  }
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

export function hookOleProviders(d: { file: string }): void {
  ipcMain.handle('ole:providers:get', () => providersOf(loadSettings(d.file)))

  ipcMain.handle('ole:providers:set', (_e, patch: unknown) => setProviders(d.file, patch))

  ipcMain.handle('ole:openai:test', () => {
    const p = providersOf(loadSettings(d.file))
    return testOpenAI({ key: readSecret(d.file, 'openai'), chatModel: p.openaiChatModel, transcribeModel: p.openaiTranscribeModel })
  })
  ipcMain.handle('ole:openai:models', () => listOpenAIModels({ key: readSecret(d.file, 'openai') }))
}
