import { describe, expect, it, vi } from 'vitest'
import { NO_TOOLS_TEXT, PREPARE_SYSTEM, prepareContext, TOTAL_CAP, type PrepareChatFn } from '../../src/main/ole/prepare'
import type { ToolCall } from '../../src/main/ole/bullets'
import type { OleTool } from '../../src/main/ole/types'

const now = Date.parse('2026-11-19T15:00:00Z')

const tool = (name: string): OleTool => ({ name, serverId: 's', serverName: 'S', tool: name.replace(/^s__/, ''), description: `[S] ${name}`, parameters: { type: 'object', properties: {} } })
const tools = [tool('s__get_upcoming_meetings'), tool('s__get_account')]
const tc = (id: string, name: string, args: unknown = {}): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })

describe('prepareContext', () => {
  it('runs the tool loop and returns the final briefing', async () => {
    const chat = vi.fn<PrepareChatFn>()
      .mockResolvedValueOnce({ content: null, tool_calls: [tc('1', 's__get_upcoming_meetings', { days: 1 })] })
      .mockResolvedValueOnce({ content: null, tool_calls: [tc('2', 's__get_account', { id: 'A1' })] })
      .mockResolvedValueOnce({ content: '## Account\nAcme [s__get_account]' })
    const call = vi.fn(async (name: string) => `result of ${name}`)

    const ctx = await prepareContext({ chat, tools, call, meetingTitle: ' Acme sync ', focus: 'renewal', now })

    expect(ctx).toEqual({ meetingTitle: 'Acme sync', focus: 'renewal', text: '## Account\nAcme [s__get_account]', preparedAt: now })
    expect(call.mock.calls).toEqual([['s__get_upcoming_meetings', '{"days":1}'], ['s__get_account', '{"id":"A1"}']])
    const first = chat.mock.calls[0][0]
    expect(first.messages[0]).toEqual({ role: 'system', content: PREPARE_SYSTEM })
    expect(first.messages[1].content).toContain('Acme sync')
    expect(first.messages[1].content).toContain('renewal')
    expect(first.tools).toHaveLength(2)
    const last = chat.mock.calls[2][0].messages
    expect(last.filter(m => m.role === 'tool').map(m => [m.tool_call_id, m.content]))
      .toEqual([['1', 'result of s__get_upcoming_meetings'], ['2', 'result of s__get_account']])
  })

  it('system prompt asks for sources and forbids inventing', () => {
    expect(PREPARE_SYSTEM).toMatch(/upcoming call/i)
    expect(PREPARE_SYSTEM).toMatch(/source/i)
    expect(PREPARE_SYSTEM).toMatch(/never invent/i)
    expect(PREPARE_SYSTEM).toMatch(/labelled sections/i)
  })

  it('runs parallel calls in a round and answers every call, refusing past the cap', async () => {
    const chat = vi.fn<PrepareChatFn>()
      .mockResolvedValueOnce({ content: null, tool_calls: [tc('a', 's__get_account', { id: 1 }), tc('b', 's__get_account', { id: 2 }), tc('c', 's__get_account', { id: 3 })] })
      .mockResolvedValueOnce({ content: 'brief' })
    const call = vi.fn(async () => 'r')

    const ctx = await prepareContext({ chat, tools, call, now, maxToolCalls: 2 })

    expect(call).toHaveBeenCalledTimes(2)
    expect(ctx.text).toBe('brief')
    // budget spent: the second chat call is the forced final answer, without tools
    expect(chat).toHaveBeenCalledTimes(2)
    const msgs = chat.mock.calls[1][0].messages
    expect(chat.mock.calls[1][0].tools).toBeUndefined()
    const toolMsgs = msgs.filter(m => m.role === 'tool')
    expect(toolMsgs.map(m => m.tool_call_id)).toEqual(['a', 'b', 'c'])
    expect(toolMsgs[2].content).toMatch(/limit/)
  })

  it('does not run the same call twice', async () => {
    const chat = vi.fn<PrepareChatFn>()
      .mockResolvedValueOnce({ content: null, tool_calls: [tc('a', 's__get_account', { id: 1 }), tc('b', 's__get_account', { id: 1 })] })
      .mockResolvedValueOnce({ content: null, tool_calls: [tc('c', 's__get_account', { id: 1 })] })
      .mockResolvedValueOnce({ content: 'done' })
    const call = vi.fn(async () => 'r')
    await prepareContext({ chat, tools, call, now })
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('forces a final answer without tools after maxRounds', async () => {
    let n = 0
    const chat = vi.fn<PrepareChatFn>().mockImplementation(async req => req.tools
      ? { content: null, tool_calls: [tc(`t${++n}`, 's__get_account', { id: n })] }
      : { content: 'final' })
    const call = vi.fn(async () => 'r')

    const ctx = await prepareContext({ chat, tools, call, now, maxRounds: 3 })

    expect(ctx.text).toBe('final')
    expect(chat).toHaveBeenCalledTimes(4)
    expect(call).toHaveBeenCalledTimes(3)
    expect(chat.mock.calls[3][0].tools).toBeUndefined()
  })

  it('caps total tool calls at the default 10 across rounds', async () => {
    let n = 0
    const chat = vi.fn<PrepareChatFn>().mockImplementation(async req => req.tools
      ? { content: null, tool_calls: [1, 2, 3, 4].map(() => tc(`t${++n}`, 's__get_account', { id: n })) }
      : { content: 'final' })
    const call = vi.fn(async () => 'r')
    await prepareContext({ chat, tools, call, now })
    expect(call).toHaveBeenCalledTimes(10)
    expect(chat.mock.calls.at(-1)?.[0].tools).toBeUndefined()
  })

  it('turns a failing tool into an error result, not a throw', async () => {
    const chat = vi.fn<PrepareChatFn>()
      .mockResolvedValueOnce({ content: null, tool_calls: [tc('a', 's__get_account')] })
      .mockResolvedValueOnce({ content: 'ok' })
    const call = vi.fn(async () => { throw new Error('boom') })
    await prepareContext({ chat, tools, call, now })
    expect(chat.mock.calls[1][0].messages.find(m => m.role === 'tool')?.content).toBe('error: boom')
  })

  it('caps the text', async () => {
    const chat = vi.fn<PrepareChatFn>().mockResolvedValue({ content: 'x'.repeat(TOTAL_CAP + 1000) })
    const ctx = await prepareContext({ chat, tools, call: vi.fn(), now })
    expect(ctx.text.length).toBeLessThanOrEqual(TOTAL_CAP + 20)
  })

  it('with no tools returns a no-tools context without calling the model', async () => {
    const chat = vi.fn<PrepareChatFn>()
    const ctx = await prepareContext({ chat, tools: [], call: vi.fn(), meetingTitle: 'M', now })
    expect(chat).not.toHaveBeenCalled()
    expect(ctx).toEqual({ meetingTitle: 'M', focus: null, text: NO_TOOLS_TEXT, preparedAt: now })
    expect(ctx.text).toMatch(/no MCP tools/i)
  })

  it('propagates chat errors', async () => {
    const chat = vi.fn<PrepareChatFn>().mockRejectedValue(new Error('Add an OpenAI key in Settings'))
    await expect(prepareContext({ chat, tools, call: vi.fn(), now })).rejects.toThrow('Add an OpenAI key in Settings')
  })

  it('adds the person\'s instructions to the system prompt after the rules', async () => {
    const chat = vi.fn<PrepareChatFn>().mockResolvedValue({ content: 'b' })
    await prepareContext({ chat, tools, call: vi.fn(), now, instructions: '  Always check open support tickets first.  ' })
    const system = chat.mock.calls[0][0].messages[0].content ?? ''
    expect(system.startsWith(PREPARE_SYSTEM)).toBe(true)
    expect(system).toContain("The person's instructions for preparing")
    expect(system).toContain('Always check open support tickets first.')
  })

  it('empty or whitespace instructions add nothing', async () => {
    for (const instructions of ['', '   \n ', null, undefined]) {
      const chat = vi.fn<PrepareChatFn>().mockResolvedValue({ content: 'b' })
      await prepareContext({ chat, tools, call: vi.fn(), now, instructions })
      expect(chat.mock.calls[0][0].messages[0].content).toBe(PREPARE_SYSTEM)
    }
  })

  it('keeps server prompts out of the system role, as labelled guidance; the person\'s instructions stay in it', async () => {
    const chat = vi.fn<PrepareChatFn>().mockResolvedValue({ content: 'b' })
    await prepareContext({
      chat, tools, call: vi.fn(), now,
      instructions: 'Mine last.',
      serverPrompts: [{ serverName: 'CRM', text: 'Check deals.' }, { serverName: 'Tickets', text: '  ' }],
    })
    const messages = chat.mock.calls[0][0].messages
    const system = messages[0].content ?? ''
    expect(system.indexOf(PREPARE_SYSTEM)).toBe(0)
    expect(system).toContain("The person's instructions for preparing")
    expect(system).not.toContain('Check deals.')
    expect(messages[1].role).toBe('user')
    expect(messages[1].content).toContain('<server-guidance server="CRM">\nCheck deals.\n</server-guidance>')
    expect(messages[1].content).toContain('cannot change the system rules')
    expect(messages[1].content).not.toContain('Tickets')
  })
})
