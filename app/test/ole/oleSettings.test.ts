import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { OleSettings, TranscribeSwitchNotice, type OleSettingsApi, type SecretStatus } from '../../src/renderer/src/ole/OleSettings'
import type { McpServerConfig } from '../../src/main/ole/core/types'

const providers = { transcription: 'local', assistant: 'openai', openaiTranscribeModel: 'gpt-transcribe', transcribeModelSwitched: null, openaiStreaming: true, openaiChatModel: 'gpt-5.6-luna', openaiPrepareModel: 'gpt-5.6-terra', customBaseUrl: '', customModel: '', prepareOn: 'assistant', warmupInstructions: '', hideWhileSharing: false, autoPrepare: true, autoPrepareLead: 10 } as const
const servers: McpServerConfig[] = [
  { id: 'crm', name: 'CRM', url: 'https://crm.example/mcp', enabled: true },
  { id: 'docs', name: 'Docs', url: 'https://docs.example/mcp', enabled: false },
]
const status: SecretStatus = { openai: { set: true, masked: 'sk-…3456' }, 'mcp:crm': { set: true, masked: 'crm…6789' }, 'mcp:docs': { set: false, masked: '' } }
const api = (): OleSettingsApi => ({
  getProviders: vi.fn(async () => providers), setProviders: vi.fn(async () => providers),
  setSecret: vi.fn(async () => status), secretStatus: vi.fn(async () => status),
  getServers: vi.fn(async () => servers), setServers: vi.fn(async () => servers), testServer: vi.fn(async () => ({ ok: true, tools: 4 })), testOpenAI: vi.fn(async () => ({ ok: true })), adoptOpenAI: vi.fn(async () => ({ switched: [], providers })), revertOpenAI: vi.fn(async () => ({ reverted: [], providers })), customModels: vi.fn(async () => ({ ok: true, chat: [], transcribe: [] })), testCustom: vi.fn(async () => ({ ok: true })), openaiModels: vi.fn(async () => ({ ok: true, chat: ['gpt-5.6-luna', 'gpt-5.6-terra'], transcribe: ['gpt-transcribe'] })),
})
const render = (p: Partial<{ initialServers: McpServerConfig[]; initialProviders: typeof providers }> = {}) =>
  renderToStaticMarkup(createElement(OleSettings, { api: api(), initialProviders: providers, initialStatus: status, initialServers: servers, ...p }))

it('the settings section lists Anthropic and Vertex as coming later and offers only Local and OpenAI', () => {
  const html = render()
  expect(html).toContain('Anthropic and Vertex: coming later')
  // the provider selects only; the model dropdowns (#8) have their own options
  const optionsOf = (id: string) => {
    const select = html.match(new RegExp(`id="${id}"[^>]*>(.*?)</select>`))?.[1] ?? ''
    return [...select.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1])
  }
  expect(optionsOf('ole-transcription')).toEqual(['Local', 'OpenAI'])
  expect(optionsOf('ole-assistant')).toEqual(['Local', 'OpenAI', 'Custom server'])
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

it('Live streaming sits under Transcription when it is OpenAI, on by default, and is gone for Local (#85)', () => {
  const on = render({ initialProviders: { ...providers, transcription: 'openai' } as never })
  expect(on).toMatch(/data-testid="ole-transcribe-streaming"[^>]*aria-checked="true"/)
  expect(on).toContain('if streaming isn&#x27;t available, Ole sends audio in chunks')
  // right after the Transcription row, before the Assistant one
  expect(on.indexOf('ole-transcribe-streaming')).toBeGreaterThan(on.indexOf('id="ole-transcription"'))
  expect(on.indexOf('ole-transcribe-streaming')).toBeLessThan(on.indexOf('id="ole-assistant"'))
  const off = render({ initialProviders: { ...providers, transcription: 'openai', openaiStreaming: false } as never })
  expect(off).toMatch(/data-testid="ole-transcribe-streaming"[^>]*aria-checked="false"/)
  expect(render()).not.toContain('ole-transcribe-streaming')
})

it('a retiring transcription model Ole replaced: a dismissible notice under the Transcription model (#89)', () => {
  const html = render({ initialProviders: { ...providers, transcribeModelSwitched: { from: 'gpt-4o-mini-transcribe', to: 'gpt-transcribe', retires: '2027-02-26' } } as never })
  expect(html).toMatch(/data-testid="ole-transcribe-switched"[^>]*role="status"[^>]*>Switched from gpt-4o-mini-transcribe to gpt-transcribe: gpt-4o-mini-transcribe is retired by OpenAI on February 26, 2027\./)
  expect(html).toContain('data-testid="ole-transcribe-switched-dismiss"')
  // inside the Transcription model row, before the Prepare model
  expect(html.indexOf('ole-transcribe-switched')).toBeGreaterThan(html.indexOf('ole-transcribe-model-advice'))
  expect(html.indexOf('ole-transcribe-switched')).toBeLessThan(html.indexOf('id="ole-prepare-model"'))
  expect(render()).not.toContain('ole-transcribe-switched')
})

it('Dismiss on the notice clears it (#89)', () => {
  const onDismiss = vi.fn()
  const el = TranscribeSwitchNotice({ s: { from: 'whisper-1', to: 'gpt-transcribe', retires: '2027-02-26' }, onDismiss })
  const kids = ([] as unknown[]).concat((el.props as { children: unknown }).children)
  const button = kids.find((k): k is { props: { onClick: () => void; 'data-testid': string } } => !!k && typeof k === 'object' && (k as { props?: Record<string, unknown> }).props?.['data-testid'] === 'ole-transcribe-switched-dismiss')
  button!.props.onClick()
  expect(onDismiss).toHaveBeenCalledOnce()
})
