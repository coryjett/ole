import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { OleSettings, type OleSettingsApi } from '../../src/renderer/src/ole/OleSettings'

const providers = { transcription: 'local', assistant: 'openai', openaiTranscribeModel: 'gpt-4o-mini-transcribe', openaiChatModel: 'gpt-5.6-luna', mcpUrl: '' } as const
const status = { openai: { set: true, masked: 'sk-…3456' }, mcp: { set: false, masked: '' } }
const api = (): OleSettingsApi => ({ getProviders: vi.fn(async () => providers), setProviders: vi.fn(async () => providers), setSecret: vi.fn(async () => status), secretStatus: vi.fn(async () => status) })
const render = () => renderToStaticMarkup(createElement(OleSettings, { api: api(), initialProviders: providers, initialStatus: status }))

it('the settings section lists Anthropic and Vertex as coming later and offers only Local and OpenAI', () => {
  const html = render()
  expect(html).toContain('Anthropic and Vertex: coming later')
  const options = [...html.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1])
  expect(options).toEqual(['Local', 'OpenAI', 'Local', 'OpenAI'])
  expect(html).toMatch(/id="ole-assistant"[^>]*>.*<option value="openai" selected="">OpenAI/)
  expect(html).toContain('value="gpt-5.6-luna"')
  expect(html).toContain('settings-section-heading')
})

it('key fields show the masked value, never the key', () => {
  const html = render()
  expect(html).toContain('Saved: sk-…3456')
  expect(html).toMatch(/id="ole-key-openai"[^>]*type="password"/)
  expect(html).not.toContain('sk-test')
  expect(html).toContain('data-testid="ole-key-openai-clear"')
  expect(html).not.toContain('data-testid="ole-key-mcp-clear"')
  expect(html).toMatch(/data-testid="ole-key-mcp-status"[^>]*>Not set/)
  // the password inputs start empty: the saved key is never put back in the field
  for (const m of html.matchAll(/<input[^>]*type="password"[^>]*>/g)) expect(m[0]).toContain('value=""')
})

it('renders disabled controls while loading', () => {
  const html = renderToStaticMarkup(createElement(OleSettings, { api: api() }))
  expect(html).toMatch(/id="ole-transcription"[^>]*disabled/)
  expect(html).toContain('Not set')
})
