import { describe, expect, it, vi } from 'vitest'
import { prepareContext, PREPARE_SYSTEM, NO_MATCH_PREFIX } from '../../src/main/ole/core/prepare'
import type { OleTool } from '../../src/main/ole/core/types'

const tool = (name: string): OleTool => ({ name: `s__${name}`, serverId: 's', serverName: 'S', tool: name, description: name, parameters: { type: 'object' } })
const TOOLS = [tool('get_upcoming_meetings'), tool('search_accounts')]
const call = (id: string, name: string, args = '{}') => ({ id, type: 'function' as const, function: { name, arguments: args } })
const NO_MATCH = "Couldn't match this call to a meeting or account. Type a company in Focus and press Refresh briefing."

describe('Prepare searches before giving up (#62)', () => {
  it('the rules say to search for the focus or the company in the title first', () => {
    expect(PREPARE_SYSTEM).toContain('search for it with the tools before you may say there is no match')
    expect(NO_MATCH.startsWith(NO_MATCH_PREFIX)).toBe(true)
  })

  it('a no-match reply with a focus and no search yet is sent back once to search', async () => {
    const chat = vi.fn()
      .mockResolvedValueOnce({ content: null, tool_calls: [call('1', 's__get_upcoming_meetings')] })
      .mockResolvedValueOnce({ content: NO_MATCH })
      .mockResolvedValueOnce({ content: null, tool_calls: [call('2', 's__search_accounts', '{"name":"NielsenIQ"}')] })
      .mockResolvedValueOnce({ content: '## Before you join\n- x' })
    const log = vi.fn()
    const out = await prepareContext({ chat, tools: TOOLS, call: async () => '[]', focus: 'NielsenIQ', log })
    expect(out.text).toBe('## Before you join\n- x')
    // the messages array is shared across calls, so look for the nudge in it
    expect(chat.mock.calls[2][0].messages).toContainEqual({ role: 'user', content: 'You have not searched for "NielsenIQ" yet. Search for it with the tools before deciding there is no match.' })
    expect(log).toHaveBeenCalledWith('ole prepare: 2 tool calls (get_upcoming_meetings 1, search_accounts 1), searched again once')
  })

  it('a no-match after a search stands, and is not sent back', async () => {
    const chat = vi.fn()
      .mockResolvedValueOnce({ content: null, tool_calls: [call('1', 's__search_accounts', '{"name":"Zebra"}')] })
      .mockResolvedValueOnce({ content: NO_MATCH })
    const log = vi.fn()
    const out = await prepareContext({ chat, tools: TOOLS, call: async () => '[]', focus: 'Zebra', log })
    expect(out.text).toBe(NO_MATCH)
    expect(chat).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenCalledWith('ole prepare: 1 tool calls (search_accounts 1)')
  })
})
