// Ole: which engine transcribes and which writes notes and answers (Local or OpenAI), with the OpenAI model names.
import { ipcMain } from 'electron'
import { loadSettings, updateSettings, type Settings } from '../settings'
import type { OleProviders, ProviderChoice } from './types'

type OleProviderSettings = Settings & {
  oleTranscription?: string
  oleAssistant?: string
  oleTranscribeModel?: string
  oleChatModel?: string
  oleSiestaUrl?: string
}

export const PROVIDER_DEFAULTS: OleProviders = {
  transcription: 'local',
  assistant: 'local',
  openaiTranscribeModel: 'gpt-4o-mini-transcribe',
  openaiChatModel: 'gpt-5.6-luna',
  siestaUrl: ''
}

export const isProviderChoice = (v: unknown): v is ProviderChoice => v === 'local' || v === 'openai'

/** an https URL with no spaces or credentials, at most 300 characters */
export function isValidSiestaUrl(v: string): boolean {
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
  const assistant = isProviderChoice(settings.oleAssistant) ? settings.oleAssistant : PROVIDER_DEFAULTS.assistant

  let openaiTranscribeModel = (settings.oleTranscribeModel ?? '').trim()
  if (!isValidModelName(openaiTranscribeModel)) {
    openaiTranscribeModel = PROVIDER_DEFAULTS.openaiTranscribeModel
  }

  let openaiChatModel = (settings.oleChatModel ?? '').trim()
  if (!isValidModelName(openaiChatModel)) {
    openaiChatModel = PROVIDER_DEFAULTS.openaiChatModel
  }

  const url = (settings.oleSiestaUrl ?? '').trim()
  const siestaUrl = isValidSiestaUrl(url) ? url : PROVIDER_DEFAULTS.siestaUrl

  return { transcription, assistant, openaiTranscribeModel, openaiChatModel, siestaUrl }
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
  if ('openaiChatModel' in p) {
    const model = typeof p.openaiChatModel === 'string' ? p.openaiChatModel.trim() : ''
    if (isValidModelName(model)) {
      settingsPatch.oleChatModel = model
    }
  }

  if ('siestaUrl' in p && typeof p.siestaUrl === 'string') {
    const url = p.siestaUrl.trim()
    if (url === '' || isValidSiestaUrl(url)) settingsPatch.oleSiestaUrl = url
  }

  return providersOf(updateSettings(file, settingsPatch as Partial<Settings>))
}

export function hookOleProviders(d: { file: string }): void {
  ipcMain.handle('ole:providers:get', () => providersOf(loadSettings(d.file)))

  ipcMain.handle('ole:providers:set', (_e, patch: unknown) => setProviders(d.file, patch))
}
