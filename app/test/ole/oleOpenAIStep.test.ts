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
    expect((await saveOpenAIKey(a, '  sk-test-123456 ', true)).ok).toBe(true)
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
    expect(html).toContain('Save and test')
  })
})

describe('first-run MCP server screen (#29)', () => {
  it('uses the same server list as Settings, with Test on each server', async () => {
    const { OleServersStep } = await import('../../src/renderer/src/ole/OleOpenAIStep')
    const { OleServers } = await import('../../src/renderer/src/ole/OleSettings')
    const Layout = (p: { title: string; actions: unknown }) => createElement('section', null, createElement('h1', null, p.title), p.actions as never)
    const api = { getServers: async () => [], setServers: async () => [], testServer: async () => ({ ok: true, tools: 1 }), setSecret: async () => ({}), secretStatus: async () => ({}) }
    const step = renderToStaticMarkup(createElement(() => OleServersStep({ api: api as never, Layout: Layout as never, art: null, onNext: () => {} }) as never))
    expect(step).toContain('Add your MCP server')
    expect(step).toContain('data-testid="ole-servers"')
    const withServer = renderToStaticMarkup(createElement(OleServers, { api: api as never, initialServers: [{ id: 'crm', name: 'CRM', url: 'https://crm.example/mcp', enabled: true }], initialStatus: {} }))
    expect(withServer).toContain('data-testid="ole-server-crm-test"')
  })
  it('the OpenAI result line matches Settings', async () => {
    const { openAIResultText } = await import('../../src/renderer/src/ole/OleOpenAIStep')
    expect(openAIResultText({ ok: true, chatModel: { name: 'gpt-5.6-luna', found: true } })).toBe('✓ Key works · gpt-5.6-luna available')
    expect(openAIResultText({ ok: false, error: 'OpenAI rejected the key' })).toBe('✕ OpenAI rejected the key')
  })
})
