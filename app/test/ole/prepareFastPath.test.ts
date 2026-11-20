import { describe, expect, it, vi } from 'vitest'
import { FAST_PATH_TIMEOUT_MS, meetingContextArgs, prepareContext, SERVER_MATCHED_LINE, serverMatched, type PrepareChatFn } from '../../src/main/ole/prepare'
import type { ToolCall } from '../../src/main/ole/bullets'
import type { OleTool } from '../../src/main/ole/types'

const now = Date.parse('2026-11-19T15:00:00Z')
const startsAt = Date.parse('2026-11-19T15:30:00Z')
const CTX_PROPS = { meeting_title: { type: 'string' }, focus: { type: 'string' }, starts_at: { type: 'string' } }
const tool = (serverId: string, name: string, properties: Record<string, unknown> = {}): OleTool =>
  ({ name: `${serverId}__${name}`, serverId, serverName: serverId.toUpperCase(), tool: name, description: name, parameters: { type: 'object', properties } })
const tc = (id: string, name: string, args: unknown = {}): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const MATCHED = JSON.stringify({ account: { name: 'Example Co' }, matchedBy: 'calendar attendee domain', meeting: { title: 'Example Co sync' } })
const NO_MATCH = "Couldn't match this call to a meeting or record. Type a name in Focus and press Refresh briefing."

describe('Prepare: meeting-context fast path (#93)', () => {
  it('calls the tool before the model with the title, focus and start, and hands the result over as the first tool result', async () => {
    const tools = [tool('s', 'get_meeting_context', CTX_PROPS), tool('s', 'search_accounts')]
    const call = vi.fn(async () => MATCHED)
    const chat = vi.fn<PrepareChatFn>().mockResolvedValueOnce({ content: '## Before you join\n- x' })
    const log = vi.fn()

    const out = await prepareContext({ chat, tools, call, meetingTitle: 'Example Co sync', focus: 'renewal', startsAt, now, log })

    expect(out.text).toBe('## Before you join\n- x')
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith('s__get_meeting_context', JSON.stringify({ meeting_title: 'Example Co sync', focus: 'renewal', starts_at: '2026-11-19T15:30:00.000Z' }))
    // one model turn: the briefing is written straight from the fast path's result
    expect(chat).toHaveBeenCalledTimes(1)
    const msgs = chat.mock.calls[0][0].messages
    const userAt = msgs.findIndex(m => m.role === 'user' && m.content?.startsWith('Now:'))
    expect(msgs[userAt + 1]).toEqual({ role: 'assistant', content: null, tool_calls: [tc('fast_path_0', 's__get_meeting_context', { meeting_title: 'Example Co sync', focus: 'renewal', starts_at: '2026-11-19T15:30:00.000Z' })] })
    expect(msgs[userAt + 2]).toEqual({ role: 'tool', tool_call_id: 'fast_path_0', content: MATCHED })
    expect(msgs.findIndex(m => m.role === 'tool')).toBe(userAt + 2)
    expect(log).toHaveBeenCalledWith('ole prepare: 1 tool calls (get_meeting_context 1), fast path')
  })

  it('is skipped when no server offers the tool: the loop and the log line are as before', async () => {
    const tools = [tool('s', 'get_upcoming_meetings'), tool('s', 'get_meeting')]
    const call = vi.fn(async () => '[]')
    const chat = vi.fn<PrepareChatFn>()
      .mockResolvedValueOnce({ content: null, tool_calls: [tc('1', 's__get_upcoming_meetings')] })
      .mockResolvedValueOnce({ content: 'brief' })
    const log = vi.fn()
    await prepareContext({ chat, tools, call, meetingTitle: 'Sync', startsAt, now, log })
    expect(call.mock.calls).toEqual([['s__get_upcoming_meetings', '{}']])
    // the messages array is shared across calls: nothing from a fast path is in it
    expect(chat.mock.calls[0][0].messages.some(m => m.tool_call_id?.startsWith('fast_path') || m.tool_calls?.some(c => c.id.startsWith('fast_path')))).toBe(false)
    expect(log).toHaveBeenCalledWith('ole prepare: 1 tool calls (get_upcoming_meetings 1)')
  })

  it('a name that only resembles the convention is not the fast path', async () => {
    const call = vi.fn(async () => '{}')
    const chat = vi.fn<PrepareChatFn>().mockResolvedValueOnce({ content: 'brief' })
    await prepareContext({ chat, tools: [tool('s', 'get_meeting_context_v2'), tool('s', 'meeting_context')], call, meetingTitle: 'Sync', now, log: () => {} })
    expect(call).not.toHaveBeenCalled()
  })

  it('calls each server that offers the tool, in parallel, and includes every result', async () => {
    const tools = [tool('a', 'get_meeting_context', CTX_PROPS), tool('b', 'get_meeting_context', CTX_PROPS), tool('a', 'search_accounts')]
    let inFlight = 0, most = 0
    const call = vi.fn(async (name: string) => {
      inFlight++; most = Math.max(most, inFlight)
      await new Promise(r => setTimeout(r, 5))
      inFlight--
      return `{"from":"${name}"}`
    })
    const chat = vi.fn<PrepareChatFn>().mockResolvedValueOnce({ content: 'brief' })
    const log = vi.fn()
    await prepareContext({ chat, tools, call, meetingTitle: 'Sync', now, log })
    expect(most).toBe(2)
    const msgs = chat.mock.calls[0][0].messages
    const asked = msgs.find(m => m.role === 'assistant')!
    expect(asked.tool_calls!.map(c => [c.id, c.function.name])).toEqual([['fast_path_0', 'a__get_meeting_context'], ['fast_path_1', 'b__get_meeting_context']])
    expect(msgs.filter(m => m.role === 'tool').map(m => [m.tool_call_id, m.content]))
      .toEqual([['fast_path_0', '{"from":"a__get_meeting_context"}'], ['fast_path_1', '{"from":"b__get_meeting_context"}']])
    expect(log).toHaveBeenCalledWith('ole prepare: 2 tool calls (get_meeting_context 2), fast path')
  })

  it('a failed call logs one line and the loop runs as it would without the tool', async () => {
    const tools = [tool('s', 'get_meeting_context', CTX_PROPS), tool('s', 'get_upcoming_meetings')]
    const call = vi.fn(async (name: string) => name === 's__get_meeting_context' ? 'error: the server returned 500' : '[]')
    const chat = vi.fn<PrepareChatFn>()
      .mockResolvedValueOnce({ content: null, tool_calls: [tc('1', 's__get_upcoming_meetings')] })
      .mockResolvedValueOnce({ content: 'brief' })
    const log = vi.fn()
    const out = await prepareContext({ chat, tools, call, meetingTitle: 'Sync', now, log })
    expect(out.text).toBe('brief')
    expect(chat.mock.calls[0][0].messages.some(m => m.tool_call_id?.startsWith('fast_path') || m.tool_calls?.some(c => c.id.startsWith('fast_path')))).toBe(false)
    expect(chat.mock.calls[0][0].messages.find(m => m.role === 'user' && m.content?.startsWith('Now:'))!.content).not.toContain(SERVER_MATCHED_LINE)
    expect(log.mock.calls.map(c => c[0])).toEqual([
      'ole prepare: get_meeting_context on S failed (the server returned 500), using the tool loop',
      'ole prepare: 1 tool calls (get_upcoming_meetings 1)',
    ])
  })

  it('a thrown or timed-out call falls back too', async () => {
    vi.useFakeTimers()
    try {
      const tools = [tool('a', 'get_meeting_context'), tool('b', 'get_meeting_context')]
      const call = vi.fn((name: string) => name.startsWith('a__') ? Promise.reject(new Error('boom')) : new Promise<string>(() => {}))
      const chat = vi.fn<PrepareChatFn>().mockResolvedValueOnce({ content: 'brief' })
      const log = vi.fn()
      const done = prepareContext({ chat, tools, call, meetingTitle: 'Sync', now, log })
      await vi.advanceTimersByTimeAsync(FAST_PATH_TIMEOUT_MS + 1)
      expect((await done).text).toBe('brief')
      expect(log.mock.calls.map(c => c[0])).toEqual([
        'ole prepare: get_meeting_context on A failed (boom), using the tool loop',
        'ole prepare: get_meeting_context on B failed (timed out), using the tool loop',
        'ole prepare: 0 tool calls',
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('counts toward the tool-call budget, and the model is not given the same call again', async () => {
    const tools = [tool('s', 'get_meeting_context', CTX_PROPS), tool('s', 'get_account')]
    const call = vi.fn(async () => '{"x":1}')
    const chat = vi.fn<PrepareChatFn>()
      .mockResolvedValueOnce({ content: null, tool_calls: [tc('1', 's__get_meeting_context', { meeting_title: 'Sync' }), tc('2', 's__get_account', { id: 1 }), tc('3', 's__get_account', { id: 2 })] })
      .mockResolvedValueOnce({ content: 'brief' })
    await prepareContext({ chat, tools, call, meetingTitle: 'Sync', now, maxToolCalls: 2, log: () => {} })
    // the fast path, then one more under a budget of 2; the repeat is answered from the first run
    expect(call.mock.calls).toEqual([['s__get_meeting_context', '{"meeting_title":"Sync"}'], ['s__get_account', '{"id":1}']])
    const toolMsgs = chat.mock.calls[1][0].messages.filter(m => m.role === 'tool')
    expect(toolMsgs.map(m => m.content)).toEqual(['{"x":1}', '{"x":1}', '{"x":1}', 'not run: the tool call limit is reached, write the briefing from what you have'])
  })

  it('the tool is offered to the model even when a server prompt narrows the first tools', async () => {
    const tools = [tool('s', 'get_meeting_context', CTX_PROPS), tool('s', 'get_account'), tool('s', 'list_files')]
    const chat = vi.fn<PrepareChatFn>().mockResolvedValueOnce({ content: 'brief' })
    await prepareContext({ chat, tools, call: async () => '{}', meetingTitle: 'Sync', now, log: () => {}, serverPrompts: [{ serverId: 's', serverName: 'S', text: 'Call get_account.' }] })
    const offered = (chat.mock.calls[0][0].tools as Array<{ function: { name: string } }>).map(t => t.function.name)
    expect(offered).toEqual(['s__get_account', 's__get_meeting_context', 'more_tools'])
  })
})

describe('the fast path and the search-first nudge (#62, #93)', () => {
  const tools = [tool('s', 'get_meeting_context', CTX_PROPS), tool('s', 'search_accounts')]

  it('a server match skips the nudge and the request says the meeting is matched', async () => {
    const chat = vi.fn<PrepareChatFn>().mockResolvedValueOnce({ content: NO_MATCH })
    const log = vi.fn()
    await prepareContext({ chat, tools, call: async () => MATCHED, meetingTitle: 'Example Co sync', focus: 'Example Co', now, log })
    expect(chat).toHaveBeenCalledTimes(1)
    const ask = chat.mock.calls[0][0].messages.find(m => m.role === 'user' && m.content?.startsWith('Now:'))!.content!
    expect(ask).toContain(SERVER_MATCHED_LINE)
    expect(log).toHaveBeenCalledWith('ole prepare: 1 tool calls (get_meeting_context 1), fast path')
  })

  it('a result with matchedBy null keeps the nudge and does not claim a match', async () => {
    const chat = vi.fn<PrepareChatFn>()
      .mockResolvedValueOnce({ content: NO_MATCH })
      .mockResolvedValueOnce({ content: null, tool_calls: [tc('1', 's__search_accounts', { name: 'Example Co' })] })
      .mockResolvedValueOnce({ content: 'brief' })
    const log = vi.fn()
    await prepareContext({ chat, tools, call: async () => '{"account":null,"matchedBy":null}', focus: 'Example Co', now, log })
    const msgs = chat.mock.calls[0][0].messages
    expect(msgs.find(m => m.role === 'user' && m.content?.startsWith('Now:'))!.content).not.toContain(SERVER_MATCHED_LINE)
    expect(msgs).toContainEqual({ role: 'user', content: 'You have not searched for "Example Co" yet. Search for it with the tools before deciding there is no match.' })
    expect(log).toHaveBeenCalledWith('ole prepare: 2 tool calls (get_meeting_context 1, search_accounts 1), searched again once, fast path')
  })

  it('serverMatched reads only a non-empty JSON object with matchedBy set', () => {
    expect(serverMatched(MATCHED)).toBe(true)
    expect(serverMatched('{"matchedBy":"title"}')).toBe(true)
    expect(serverMatched('{"matchedBy":null,"account":{"name":"x"}}')).toBe(false)
    expect(serverMatched('{"account":{"name":"x"}}')).toBe(false)
    expect(serverMatched('{}')).toBe(false)
    expect(serverMatched('[{"matchedBy":"x"}]')).toBe(false)
    expect(serverMatched('matchedBy: title')).toBe(false)
    expect(serverMatched('{"matchedBy":"x"}\n[truncated]')).toBe(false)
  })
})

describe('meetingContextArgs', () => {
  it('sends only known values, as ISO for the start', () => {
    expect(meetingContextArgs(tool('s', 'get_meeting_context', CTX_PROPS), { meetingTitle: 'Sync', focus: null, startsAt: null })).toEqual({ meeting_title: 'Sync' })
    expect(meetingContextArgs(tool('s', 'get_meeting_context', CTX_PROPS), { meetingTitle: null, focus: null, startsAt })).toEqual({ starts_at: '2026-11-19T15:30:00.000Z' })
  })

  it('leaves out what the schema does not declare, and sends all when it declares nothing', () => {
    expect(meetingContextArgs(tool('s', 'get_meeting_context', { meeting_title: {} }), { meetingTitle: 'Sync', focus: 'f', startsAt })).toEqual({ meeting_title: 'Sync' })
    expect(meetingContextArgs(tool('s', 'get_meeting_context'), { meetingTitle: 'Sync', focus: 'f', startsAt })).toEqual({ meeting_title: 'Sync', focus: 'f', starts_at: '2026-11-19T15:30:00.000Z' })
  })
})
