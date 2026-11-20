import { describe, expect, it } from 'vitest'
import { isLiveTool } from '../../src/main/ole/core/tools'
import { BULLETS_SYSTEM } from '../../src/main/ole/core/bullets'
import { ASK_SYSTEM } from '../../src/main/ole/core/ask'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { OleServers } from '../../src/renderer/src/ole/OleSettings'

describe('docs servers during a call (#64)', () => {
  it('lookup verbs query, resolve, fetch and read count, with _ or -', () => {
    for (const t of ['query-docs', 'resolve-library-id', 'fetch_page', 'read_doc', 'search-docs', 'get-page']) expect(isLiveTool({ tool: t })).toBe(true)
    for (const t of ['describe_schema', 'summarize_week', 'queryable', 'update-doc']) expect(isLiveTool({ tool: t })).toBe(false)
  })
  it('names never go to a public documentation search', () => {
    const rule = "Never put an organization's or person's name in a search of public documentation."
    expect(BULLETS_SYSTEM).toContain(rule)
    expect(ASK_SYSTEM).toContain(rule)
  })
  it('the servers setting says what Ole sends them', () => {
    const api = { getServers: async () => [], setServers: async () => [], testServer: async () => ({ ok: true, tools: 0 }), setSecret: async () => ({}), secretStatus: async () => ({}) }
    const html = renderToStaticMarkup(createElement(OleServers, { api: api as never, initialServers: [], initialStatus: {} }))
    expect(html).toContain('During a call Ole sends each server short search phrases from the conversation')
  })
})
