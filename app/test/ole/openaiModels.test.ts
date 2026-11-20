import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { listOpenAIModels } from '../../src/main/ole/core/openaiTest'
import { ModelSelect } from '../../src/renderer/src/ole/OleSettings'

const list = (ids: string[]) => vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: ids.map(id => ({ id })) }), { status: 200 }))

describe('OpenAI model list (#8)', () => {
  it('splits chat and transcription models and drops the rest', async () => {
    const r = await listOpenAIModels({ key: 'sk-test-123456', fetch: list(['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-4o-mini-transcribe', 'whisper-1', 'gpt-transcribe', 'gpt-live-transcribe', 'gpt-realtime-whisper', 'text-embedding-3-small', 'gpt-4o-mini-tts', 'dall-e-3', 'o4-mini', 'gpt-realtime']) })
    expect(r.ok).toBe(true)
    expect(r.chat).toEqual(['o4-mini', 'gpt-5.6-terra', 'gpt-5.6-luna'])
    // Realtime-only models are left out: /audio/transcriptions refuses them (#89)
    expect(r.transcribe.sort()).toEqual(['gpt-4o-mini-transcribe', 'gpt-transcribe', 'whisper-1'])
  })
  it('says why there is no list without a key, without calling OpenAI', async () => {
    const f = list([])
    expect(await listOpenAIModels({ key: null, fetch: f })).toEqual({ ok: false, error: 'Save an OpenAI key to see your models', chat: [], transcribe: [] })
    expect(f).not.toHaveBeenCalled()
  })
})

describe('model dropdown (#8)', () => {
  const render = (value: string, options?: string[], note?: string) =>
    renderToStaticMarkup(createElement(ModelSelect, { id: 'm', label: 'Prepare model', hint: 'h', role: 'prepare', value, options, note, disabled: false, onChange: () => {} }))
  it('lists the models with the saved one selected', () => {
    const html = render('gpt-5.6-terra', ['gpt-5.6-terra', 'gpt-5.6-luna'])
    expect(html).toContain('<select')
    expect(html).toContain('<option value="gpt-5.6-luna"')
    expect(html).not.toContain('available to this key')
  })
  it('keeps a saved model the key no longer has, and marks it', () => {
    const html = render('gpt-old', ['gpt-5.6-luna'])
    expect(html).toContain('<option value="gpt-old"')
    expect(html).toContain("gpt-old isn&#x27;t available to this key")
  })
  it('without a list shows the saved value and why', () => {
    const html = render('gpt-5.6-luna', [], 'Save an OpenAI key to see your models')
    expect(html).toContain('<option value="gpt-5.6-luna"')
    expect(html).toContain('Save an OpenAI key to see your models')
  })
})
