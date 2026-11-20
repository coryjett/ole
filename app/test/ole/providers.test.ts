import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>())
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) } }))
import { hookOleProviders, providersOf, setProviders } from '../../src/main/ole/providers'
import { loadSettings, updateSettings, type Settings } from '../../src/main/settings'

let dir = ''
let file = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ole-providers-')); file = join(dir, 'settings.json'); hookOleProviders({ file }) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }); handlers.clear() })

const DEFAULTS = { transcription: 'local', assistant: 'local', openaiTranscribeModel: 'gpt-4o-mini-transcribe', openaiChatModel: 'gpt-5.6-luna' }

it('defaults to local for both and the documented OpenAI models', () => {
  expect(providersOf({})).toEqual(DEFAULTS)
  expect(handlers.get('ole:providers:get')!()).toEqual(DEFAULTS)
})

it('saves valid choices under the ole settings keys', () => {
  updateSettings(file, { theme: 'dark' })
  const got = handlers.get('ole:providers:set')!(null, { transcription: 'openai', assistant: 'openai', openaiChatModel: ' gpt-5.6-sol ' })
  expect(got).toEqual({ ...DEFAULTS, transcription: 'openai', assistant: 'openai', openaiChatModel: 'gpt-5.6-sol' })
  const s = loadSettings(file) as Settings & Record<string, unknown>
  expect(s).toMatchObject({ theme: 'dark', oleTranscription: 'openai', oleAssistant: 'openai', oleChatModel: 'gpt-5.6-sol' })
})

it('rejects unknown provider values', () => {
  expect(setProviders(file, { assistant: 'anthropic', transcription: 'vertex' })).toEqual(DEFAULTS)
  setProviders(file, { assistant: 'openai' })
  expect(setProviders(file, { assistant: 'anthropic' }).assistant).toBe('openai')
  expect(setProviders(file, { openaiChatModel: '', openaiTranscribeModel: 'bad model; rm' })).toMatchObject({ openaiChatModel: 'gpt-5.6-luna', openaiTranscribeModel: 'gpt-4o-mini-transcribe' })
  expect(setProviders(file, 'openai')).toEqual({ ...DEFAULTS, assistant: 'openai' })
  expect(setProviders(file, null)).toEqual({ ...DEFAULTS, assistant: 'openai' })
})

it('a hand-edited file with bad values falls back to the defaults', () => {
  expect(providersOf({ oleAssistant: 'claude', oleTranscription: 7, oleChatModel: '  ' } as unknown as Settings)).toEqual(DEFAULTS)
})
