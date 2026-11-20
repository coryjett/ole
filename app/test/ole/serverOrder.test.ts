// Settings > Ole > MCP servers can be reordered (#98): the order is the priority for meetings.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { moveServer, OleServers } from '../../src/renderer/src/ole/OleSettings'
import { serversOf, setServers } from '../../src/main/ole/core/servers'
import type { OleSettings } from '../../src/main/ole/core/host'
import type { McpServerConfig } from '../../src/main/ole/core/types'

const list: McpServerConfig[] = [
  { id: 'crm', name: 'CRM', url: 'https://crm.example/mcp', enabled: true },
  { id: 'docs', name: 'Docs', url: 'https://docs.example/mcp', enabled: false },
  { id: 'wiki', name: 'Wiki', url: 'https://wiki.example/mcp', enabled: true },
]
const api = { getServers: vi.fn(async () => list), setServers: vi.fn(async () => list), testServer: vi.fn(), setSecret: vi.fn(), secretStatus: vi.fn(async () => ({})) }

it('each server has move up and down, off at the ends of the list, and a hint on what the order means', () => {
  const html = renderToStaticMarkup(createElement(OleServers, { api, initialServers: list, initialStatus: {} }))
  expect(html).toMatch(/data-testid="ole-server-crm-up"[^>]*disabled/)
  expect(html).not.toMatch(/data-testid="ole-server-crm-down"[^>]*disabled/)
  expect(html).not.toMatch(/data-testid="ole-server-docs-up"[^>]*disabled/)
  expect(html).toMatch(/data-testid="ole-server-wiki-down"[^>]*disabled/)
  expect(html).toContain('aria-label="Move Docs up"')
  expect(html).toContain('the first server that knows a meeting supplies its context and the meeting list')
  // one server: nothing to order
  expect(renderToStaticMarkup(createElement(OleServers, { api, initialServers: [list[0]], initialStatus: {} }))).not.toContain('data-testid="ole-servers-order"')
})

it('moveServer swaps with the neighbour and leaves the ends alone', () => {
  expect(moveServer(list, 'docs', -1).map(s => s.id)).toEqual(['docs', 'crm', 'wiki'])
  expect(moveServer(list, 'docs', 1).map(s => s.id)).toEqual(['crm', 'wiki', 'docs'])
  expect(moveServer(list, 'crm', -1)).toBe(list)
  expect(moveServer(list, 'wiki', 1)).toBe(list)
  expect(moveServer(list, 'nope', 1)).toBe(list)
})

it('a reordered list is saved in that order and keeps every key', () => {
  let settings: OleSettings = { oleMcpServers: list }
  const store = { get: () => settings, patch: (p: Partial<OleSettings>) => (settings = { ...settings, ...p }) }
  const removed: string[] = []
  setServers(store, (n) => removed.push(n), moveServer(list, 'wiki', -1))
  expect(serversOf(settings).map(s => s.id)).toEqual(['crm', 'wiki', 'docs'])
  expect(removed).toEqual([])
})
