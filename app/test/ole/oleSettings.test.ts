import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { OleSettings, type OleSettingsApi, type SecretStatus } from '../../src/renderer/src/ole/OleSettings'
import type { McpServerConfig } from '../../src/main/ole/types'

const providers = { transcription: 'local', assistant: 'openai', openaiTranscribeModel: 'gpt-4o-mini-transcribe', openaiChatModel: 'gpt-5.6-luna', warmupInstructions: '' } as const
const servers: McpServerConfig[] = [
  { id: 'crm', name: 'CRM', url: 'https://crm.example/mcp', enabled: true },
  { id: 'docs', name: 'Docs', url: 'https://docs.example/mcp', enabled: false },
]
const status: SecretStatus = { openai: { set: true, masked: 'sk-…3456' }, 'mcp:crm': { set: true, masked: 'crm…6789' }, 'mcp:docs': { set: false, masked: '' } }
const api = (): OleSettingsApi => ({
  getProviders: vi.fn(async () => providers), setProviders: vi.fn(async () => providers),
  setSecret: vi.fn(async () => status), secretStatus: vi.fn(async () => status),
  getServers: vi.fn(async () => servers), setServers: vi.fn(async () => servers), testServer: vi.fn(async () => ({ ok: true, tools: 4 })), testOpenAI: vi.fn(async () => ({ ok: true })),
})
const render = (p: Partial<{ initialServers: McpServerConfig[]; initialProviders: typeof providers }> = {}) =>
  renderToStaticMarkup(createElement(OleSettings, { api: api(), initialProviders: providers, initialStatus: status, initialServers: servers, ...p }))

it('the settings section lists Anthropic and Vertex as coming later and offers only Local and OpenAI', () => {
  const html = render()
  expect(html).toContain('Anthropic and Vertex: coming later')
  const options = [...html.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1])
  expect(options).toEqual(['Local', 'OpenAI', 'Local', 'OpenAI'])
  expect(html).toMatch(/id="ole-assistant"[^>]*>.*<option value="openai" selected="">OpenAI/)
  expect(html).toContain('value="gpt-5.6-luna"')
  expect(html).toContain('settings-section-heading')
  expect(html).not.toContain('MCP server URL')
})

it('key fields show the masked value, never the key', () => {
  const html = render()
  expect(html).toContain('Saved: sk-…3456')
  expect(html).toMatch(/id="ole-key-openai"[^>]*type="password"/)
  expect(html).not.toContain('sk-test')
  expect(html).toContain('data-testid="ole-key-openai-clear"')
  // the password inputs start empty: the saved key is never put back in the field
  for (const m of html.matchAll(/<input[^>]*type="password"[^>]*>/g)) expect(m[0]).toContain('value=""')
})

it('lists each MCP server with its URL, toggle, masked key, Test and Remove', () => {
  const html = render()
  expect(html).toContain('MCP servers')
  expect(html).toMatch(/data-testid="ole-server-crm"/)
  expect(html).toMatch(/data-testid="ole-server-crm-url"[^>]*>https:\/\/crm\.example\/mcp/)
  expect(html).toMatch(/data-testid="ole-server-crm-enabled"[^>]*aria-checked="true"/)
  expect(html).toMatch(/data-testid="ole-server-docs-enabled"[^>]*aria-checked="false"/)
  expect(html).toMatch(/data-testid="ole-key-mcp-crm-status"[^>]*>Key: Saved: crm…6789/)
  expect(html).toMatch(/data-testid="ole-key-mcp-docs-status"[^>]*>Key: Not set/)
  expect(html).toMatch(/id="ole-key-mcp-crm"[^>]*type="password"/)
  expect(html).toContain('data-testid="ole-key-mcp-crm-clear"')
  expect(html).not.toContain('data-testid="ole-key-mcp-docs-clear"')
  expect(html).toContain('data-testid="ole-server-crm-test"')
  expect(html).toContain('data-testid="ole-server-docs-remove"')
  expect(html).toContain('data-testid="ole-server-add-name"')
  expect(html).toContain('data-testid="ole-server-add-url"')
})

it('shows an empty-state line with no servers and hides Add at ten', () => {
  expect(render({ initialServers: [] })).toContain('No MCP servers yet')
  const ten = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, name: `S${i}`, url: 'https://a.example/mcp', enabled: true }))
  expect(render({ initialServers: ten })).not.toContain('data-testid="ole-server-add"')
})

it('renders the warm-up instructions textarea with its count', () => {
  const html = render({ initialProviders: { ...providers, warmupInstructions: 'Lead with risks.' } as never })
  expect(html).toContain('Warm-up instructions')
  expect(html).toContain('Sent to the model each time Ole prepares for a call.')
  expect(html).toMatch(/<textarea[^>]*data-testid="ole-warmup"[^>]*rows="8"[^>]*>Lead with risks\.<\/textarea>/)
  expect(html).toMatch(/placeholder="How should Ole prepare\?/)
  expect(html).toMatch(/data-testid="ole-warmup-count"[^>]*>16 \/ 8000</)
})

it('renders disabled controls while loading', () => {
  const html = renderToStaticMarkup(createElement(OleSettings, { api: api() }))
  expect(html).toMatch(/id="ole-transcription"[^>]*disabled/)
  expect(html).toMatch(/<textarea[^>]*disabled/)
  expect(html).toMatch(/data-testid="ole-server-add-save"[^>]*disabled/)
  expect(html).toContain('Not set')
})
