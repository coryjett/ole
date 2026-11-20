import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { OleOpenAIStep, saveOpenAIKey, type OleOpenAIStepApi } from '../../src/renderer/src/ole/OleOpenAIStep'

const api = (ok = true): OleOpenAIStepApi & { setSecret: ReturnType<typeof vi.fn>; adoptOpenAI: ReturnType<typeof vi.fn> } => ({
  setSecret: vi.fn(async () => ({})),
  testOpenAI: vi.fn(async () => ok ? { ok: true } : { ok: false, error: 'OpenAI rejected the key' }),
  adoptOpenAI: vi.fn(async () => ({})),
})

describe('first-run OpenAI step', () => {
  it('saves and tests the key, then switches Local providers to OpenAI', async () => {
    const a = api()
    expect(await saveOpenAIKey(a, '  sk-test-123456 ', true)).toEqual({ ok: true })
    expect(a.setSecret).toHaveBeenCalledWith('openai', 'sk-test-123456')
    expect(a.adoptOpenAI).toHaveBeenCalled()
  })
  it('leaves the providers alone when the box is unticked', async () => {
    const a = api()
    await saveOpenAIKey(a, 'sk-test-123456', false)
    expect(a.adoptOpenAI).not.toHaveBeenCalled()
  })
  it('a key that fails the test stops there, with the reason', async () => {
    const a = api(false)
    expect(await saveOpenAIKey(a, 'sk-bad', true)).toEqual({ ok: false, error: 'OpenAI rejected the key' })
    expect(a.adoptOpenAI).not.toHaveBeenCalled()
  })
  it('an empty key asks for one and saves nothing', async () => {
    const a = api()
    expect((await saveOpenAIKey(a, '   ', true)).ok).toBe(false)
    expect(a.setSecret).not.toHaveBeenCalled()
  })
  it('renders a key field, the option, Save and Not now', () => {
    const Layout = (p: { title: string; actions: unknown }) => createElement('section', null, createElement('h1', null, p.title), p.actions as never)
    const html = renderToStaticMarkup(createElement(() => OleOpenAIStep({ api: api(), Layout: Layout as never, art: null, onNext: () => {} }) as never))
    expect(html).toContain('Connect OpenAI')
    expect(html).toContain('type="password"')
    expect(html).toContain('Also use OpenAI for transcription and summaries')
    expect(html).toContain('Not now')
  })
})
