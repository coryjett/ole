import { describe, expect, it, vi } from 'vitest'
import { isLiveTool, MORE_TOOLS, narrowForPrepare } from '../../src/main/ole/core/tools'
import { prepareContext, type PrepareChatFn } from '../../src/main/ole/core/prepare'
import type { OleTool } from '../../src/main/ole/core/types'

const tool = (serverId: string, name: string): OleTool => ({ name: `${serverId}__${name}`, serverId, serverName: serverId.toUpperCase(), tool: name, description: '', parameters: { type: 'object', properties: {} } })
const crm = ['get_account_details', 'get_opportunities', 'search_calls', 'get_fire_score'].map(n => tool('crm', n))
const docs = ['search_docs', 'get_page'].map(n => tool('docs', n))
const prompt = { serverId: 'crm', serverName: 'CRM', text: 'Call get_account_details, then get_opportunities. Skip get_fire_score_history.' }

describe('fewer tools (#15)', () => {
  it("a server's prompt narrows its own tools to the ones it names; a server without one keeps all", () => {
    const { first, rest } = narrowForPrepare([...crm, ...docs], [prompt])
    expect(first.map(t => t.name)).toEqual(['crm__get_account_details', 'crm__get_opportunities', 'docs__search_docs', 'docs__get_page'])
    expect(rest.map(t => t.name)).toEqual(['crm__search_calls', 'crm__get_fire_score'])
  })
  it('matches whole tool names only (get_fire_score is not named by get_fire_score_history)', () => {
    expect(narrowForPrepare(crm, [prompt]).rest.map(t => t.tool)).toContain('get_fire_score')
  })
  it('no prompt, or a prompt naming none of its tools, offers everything', () => {
    expect(narrowForPrepare(crm, []).rest).toEqual([])
    expect(narrowForPrepare(crm, [{ serverId: 'crm', serverName: 'CRM', text: 'Be brief.' }]).rest).toEqual([])
  })
  it('Prepare offers the short list plus more_tools, and more_tools widens it for the run', async () => {
    const offered: string[][] = []
    const chat = vi.fn<PrepareChatFn>(async (req) => {
      offered.push((req.tools ?? []).map((t: any) => t.function.name))
      if (offered.length === 1) return { content: null, tool_calls: [{ id: '1', type: 'function', function: { name: MORE_TOOLS, arguments: '{}' } }] }
      return { content: 'briefing' }
    })
    const r = await prepareContext({ chat, tools: crm, call: vi.fn(), serverPrompts: [prompt], now: 0 })
    expect(r.text).toBe('briefing')
    expect(offered[0]).toEqual(['crm__get_account_details', 'crm__get_opportunities', MORE_TOOLS])
    expect(offered[1]).toEqual(expect.arrayContaining(['crm__search_calls', 'crm__get_fire_score']))
    expect(offered[1]).not.toContain(MORE_TOOLS)
  })
  it('live bullets get lookup-style tools by name', () => {
    expect(isLiveTool({ tool: 'search_calls' })).toBe(true)
    expect(isLiveTool({ tool: 'get_account_details' })).toBe(true)
    expect(isLiveTool({ tool: 'describe_schema' })).toBe(false)
    expect(isLiveTool({ tool: 'summarize_week' })).toBe(false)
  })
})
