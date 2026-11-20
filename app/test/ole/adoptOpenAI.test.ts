import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, safeStorage: { isEncryptionAvailable: () => false } }))
const { adoptOpenAI, revertOpenAI, setProviders, providersOf } = await import('../../src/main/ole/providers')
const { loadSettings } = await import('../../src/main/settings')

let file = ''
beforeEach(() => { file = join(mkdtempSync(join(tmpdir(), 'ole-adopt-')), 'settings.json') })

describe('an OpenAI key switches untouched providers to OpenAI (#10)', () => {
  it('switches both when neither was chosen, and says which', () => {
    const r = adoptOpenAI(file)
    expect(r.switched).toEqual(['transcription', 'assistant'])
    expect(providersOf(loadSettings(file))).toMatchObject({ transcription: 'openai', assistant: 'openai' })
  })
  it('never switches a provider the person chose', () => {
    setProviders(file, { transcription: 'local' })
    expect(adoptOpenAI(file).switched).toEqual(['assistant'])
    expect(providersOf(loadSettings(file)).transcription).toBe('local')
  })
  it('undo puts them back and keeps Local as the choice, so a new key does not switch again', () => {
    adoptOpenAI(file)
    expect(revertOpenAI(file, { undo: true }).reverted).toEqual(['transcription', 'assistant'])
    expect(providersOf(loadSettings(file))).toMatchObject({ transcription: 'local', assistant: 'local' })
    expect(adoptOpenAI(file).switched).toEqual([])
  })
  it('removing the key puts back only what the key switched', () => {
    setProviders(file, { assistant: 'openai' })
    adoptOpenAI(file)
    expect(revertOpenAI(file, { undo: false }).reverted).toEqual(['transcription'])
    expect(providersOf(loadSettings(file))).toMatchObject({ transcription: 'local', assistant: 'openai' })
  })
  it('a dropdown change after the switch makes that setting the person\'s own', () => {
    adoptOpenAI(file)
    setProviders(file, { transcription: 'openai' })
    expect(revertOpenAI(file, { undo: false }).reverted).toEqual(['assistant'])
  })
})
