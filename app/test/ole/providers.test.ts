import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>())
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) } }))
import { hookOleProviders, providersOf, setProviders } from '../../src/main/ole/yogurt/providers'
import { loadSettings, updateSettings, type Settings } from '../../src/main/settings'

let dir = ''
let file = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ole-providers-')); file = join(dir, 'settings.json'); hookOleProviders({ file }) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }); handlers.clear() })

const DEFAULTS = { transcription: 'local', assistant: 'local', openaiTranscribeModel: 'gpt-transcribe', transcribeModelSwitched: null, openaiStreaming: true, openaiChatModel: 'gpt-5.6-luna', openaiPrepareModel: 'gpt-5.6-terra', customBaseUrl: '', customModel: '', prepareOn: 'assistant', warmupInstructions: '', hideWhileSharing: false, autoPrepare: true, autoPrepareLead: 10 }

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
  expect(setProviders(file, { openaiChatModel: '', openaiTranscribeModel: 'bad model; rm' })).toMatchObject({ openaiChatModel: 'gpt-5.6-luna', openaiPrepareModel: 'gpt-5.6-terra', customBaseUrl: '', customModel: '', prepareOn: 'assistant', openaiTranscribeModel: 'gpt-transcribe' })
  expect(setProviders(file, 'openai')).toEqual({ ...DEFAULTS, assistant: 'openai' })
  expect(setProviders(file, null)).toEqual({ ...DEFAULTS, assistant: 'openai' })
})

it('a hand-edited file with bad values falls back to the defaults', () => {
  expect(providersOf({ oleAssistant: 'claude', oleTranscription: 7, oleChatModel: '  ' } as unknown as Settings)).toEqual(DEFAULTS)
})

it('warm-up instructions are trimmed, cut at 8000 characters and stored under oleWarmupInstructions', () => {
  expect(setProviders(file, { warmupInstructions: '  Lead with risks.\n' }).warmupInstructions).toBe('Lead with risks.')
  expect((loadSettings(file) as Settings & Record<string, unknown>).oleWarmupInstructions).toBe('Lead with risks.')
  expect(setProviders(file, { warmupInstructions: 'a'.repeat(9000) }).warmupInstructions).toHaveLength(8000)
  expect(setProviders(file, { warmupInstructions: 42 }).warmupInstructions).toHaveLength(8000)
  expect(setProviders(file, { warmupInstructions: '' }).warmupInstructions).toBe('')
  expect('oleWarmupInstructions' in loadSettings(file)).toBe(false)
  expect(providersOf({ oleWarmupInstructions: 7 } as unknown as Settings).warmupInstructions).toBe('')
})

it('no longer reads or writes an MCP URL', () => {
  expect(providersOf({ oleMcpUrl: 'https://x.example/mcp' } as unknown as Settings)).toEqual(DEFAULTS)
  setProviders(file, { mcpUrl: 'https://x.example/mcp' })
  expect('oleMcpUrl' in loadSettings(file)).toBe(false)
})

it('streaming is on unless turned off, saved as oleTranscribeStreaming, and ignores non-booleans (#85)', () => {
  expect(providersOf({}).openaiStreaming).toBe(true)
  expect(setProviders(file, { openaiStreaming: false }).openaiStreaming).toBe(false)
  expect((loadSettings(file) as Settings & Record<string, unknown>).oleTranscribeStreaming).toBe(false)
  expect(setProviders(file, { openaiStreaming: 'yes' } as never).openaiStreaming).toBe(false)
  expect(setProviders(file, { openaiStreaming: true }).openaiStreaming).toBe(true)
})

it('a saved retiring transcription model reads as gpt-transcribe, with a notice, without writing (#89)', () => {
  updateSettings(file, { oleTranscribeModel: 'gpt-4o-mini-transcribe' })
  const p = handlers.get('ole:providers:get')!()
  expect(p.openaiTranscribeModel).toBe('gpt-transcribe')
  expect(p.transcribeModelSwitched).toEqual({ from: 'gpt-4o-mini-transcribe', to: 'gpt-transcribe', retires: '2027-02-26' })
  expect(loadSettings(file).oleTranscribeModel).toBe('gpt-4o-mini-transcribe')
})

it('the next write saves the successor and keeps the notice until it is dismissed (#89)', () => {
  updateSettings(file, { oleTranscribeModel: 'whisper-1' })
  const p = setProviders(file, { openaiStreaming: false })
  expect(p).toMatchObject({ openaiTranscribeModel: 'gpt-transcribe', openaiStreaming: false, transcribeModelSwitched: { from: 'whisper-1', to: 'gpt-transcribe', retires: '2027-02-26' } })
  expect(loadSettings(file)).toMatchObject({ oleTranscribeModel: 'gpt-transcribe', oleTranscribeModelSwitched: { from: 'whisper-1', to: 'gpt-transcribe', retires: '2027-02-26' } })
  // the stored model is no longer retiring, so the notice now comes from what was recorded
  expect(providersOf(loadSettings(file)).transcribeModelSwitched).toEqual({ from: 'whisper-1', to: 'gpt-transcribe', retires: '2027-02-26' })
  const after = setProviders(file, { transcribeModelSwitched: null })
  expect(after.transcribeModelSwitched).toBeNull()
  expect(after.openaiTranscribeModel).toBe('gpt-transcribe')
  expect(loadSettings(file).oleTranscribeModelSwitched).toBeUndefined()
})

it('a dismiss sent while the model is still retiring saves the successor without the notice (#89)', () => {
  updateSettings(file, { oleTranscribeModel: 'gpt-4o-transcribe' })
  expect(setProviders(file, { transcribeModelSwitched: null })).toMatchObject({ openaiTranscribeModel: 'gpt-transcribe', transcribeModelSwitched: null })
  expect(loadSettings(file).oleTranscribeModel).toBe('gpt-transcribe')
})

it('choosing a model: a current one clears the notice, a retiring one still lands on the successor (#89)', () => {
  updateSettings(file, { oleTranscribeModel: 'gpt-4o-mini-transcribe' })
  setProviders(file, { openaiStreaming: true })
  expect(setProviders(file, { openaiTranscribeModel: 'gpt-transcribe-2027-01-01' })).toMatchObject({ openaiTranscribeModel: 'gpt-transcribe-2027-01-01', transcribeModelSwitched: null })
  expect(setProviders(file, { openaiTranscribeModel: 'gpt-4o-transcribe' })).toMatchObject({ openaiTranscribeModel: 'gpt-transcribe', transcribeModelSwitched: { from: 'gpt-4o-transcribe', to: 'gpt-transcribe', retires: '2027-02-26' } })
})

it('a malformed stored notice is ignored (#89)', () => {
  for (const bad of [{ from: 'x' }, 'notice', { from: 'whisper-1', to: 'gpt-transcribe', retires: 'soon' }, { from: 'a b', to: 'gpt-transcribe', retires: '2027-02-26' }])
    expect(providersOf({ oleTranscribeModel: 'gpt-transcribe', oleTranscribeModelSwitched: bad as never }).transcribeModelSwitched).toBeNull()
})
