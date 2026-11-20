// #80: a round's lookups run together, in bullets and in Ask, with the per-minute limit and the kept results intact.
import { describe, expect, it, vi } from 'vitest'
import { createBulletsEngine, EARLIER_LOOKUP, type ChatFn, type ToolCall } from '../../src/main/ole/core/bullets'
import { answerQuestion } from '../../src/main/ole/core/ask'
import type { OleTool } from '../../src/main/ole/core/types'

const tool: OleTool = { name: 's__search_docs', serverId: 's', serverName: 'S', tool: 'search_docs', description: 'docs', parameters: { type: 'object' } }
const call = (id: string, q: string): ToolCall => ({ id, type: 'function', function: { name: 's__search_docs', arguments: JSON.stringify({ q }) } })
const ctx = { meetingTitle: 'Sync', focus: null, text: '## Before you join\n- x (docs)', preparedAt: 1 }

/** a server whose answers the test releases by hand, so it can see what is in flight at once */
function slowServer() {
  const waiting: Array<{ args: string; resolve: (s: string) => void; reject: (e: Error) => void }> = []
  const callTool = vi.fn((_name: string, args: string) => new Promise<string>((resolve, reject) => { waiting.push({ args, resolve, reject }) }))
  return { callTool, waiting }
}

const toolMessages = (chat: ReturnType<typeof vi.fn<ChatFn>>, n: number) => chat.mock.calls[n][0].messages.filter(m => m.role === 'tool')

describe('parallel lookups in a bullets turn (#80)', () => {
  it('starts every lookup of a round before any answers, and answers them in the order asked', async () => {
    const chat = vi.fn<ChatFn>()
      .mockResolvedValueOnce({ content: null, tool_calls: [call('1', 'alpha'), call('2', 'beta'), call('3', 'gamma')] })
      .mockResolvedValueOnce({ content: '{"bullets":[]}' })
    const server = slowServer()
    const engine = createBulletsEngine({ chat, tools: () => [tool], callTool: server.callTool, context: () => ctx, onBullets: () => {}, now: () => 0, log: () => {} })
    engine.push({ speaker: 'Them', text: 'tell me about alpha', startMs: 0 })
    // all three are with the server together: none waited for another
    await vi.waitFor(() => expect(server.waiting).toHaveLength(3))
    // answered out of order; the model still gets them in the order it asked
    server.waiting[2].resolve('G'); server.waiting[0].resolve('A'); server.waiting[1].reject(new Error('down'))
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2))
    engine.stop()
    expect(toolMessages(chat, 1).map(m => [m.tool_call_id, m.content])).toEqual([['1', 'A'], ['2', 'lookup failed'], ['3', 'G']])
  })

  it('keeps the per-minute limit exact when the lookups start together', async () => {
    const chat = vi.fn<ChatFn>()
      .mockResolvedValueOnce({ content: null, tool_calls: [call('1', 'a'), call('2', 'b'), call('3', 'c'), call('4', 'd')] })
      .mockResolvedValueOnce({ content: '{"bullets":[]}' })
    const callTool = vi.fn(async (_n: string, args: string) => `result ${args}`)
    const lines: string[] = []
    const engine = createBulletsEngine({ chat, tools: () => [tool], callTool, context: () => ctx, onBullets: () => {}, now: () => 0, maxLookupsPerMinute: 2, log: l => lines.push(l) })
    engine.push({ speaker: 'Them', text: 'four things please', startMs: 0 })
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2))
    engine.stop()
    expect(callTool).toHaveBeenCalledTimes(2)
    const contents = toolMessages(chat, 1).map(m => m.content)
    expect(contents.slice(0, 2)).toEqual(['result {"q":"a"}', 'result {"q":"b"}'])
    expect(contents.slice(2)).toEqual(['not allowed: lookup limit reached, answer from what you have', 'not allowed: lookup limit reached, answer from what you have'])
    // the log still counts what the model asked for
    expect(lines.at(-1)).toMatch(/, 4 lookups/)
  })

  it('two identical lookups in one round reach the server once; the second is marked as looked up earlier', async () => {
    const chat = vi.fn<ChatFn>()
      .mockResolvedValueOnce({ content: null, tool_calls: [call('1', 'ztunnel'), call('2', ' ZTUNNEL ')] })
      .mockResolvedValueOnce({ content: '{"bullets":[]}' })
    const server = slowServer()
    const engine = createBulletsEngine({ chat, tools: () => [tool], callTool: server.callTool, context: () => ctx, onBullets: () => {}, now: () => 0, maxLookupsPerMinute: 1, log: () => {} })
    engine.push({ speaker: 'Them', text: 'how does ztunnel work', startMs: 0 })
    await vi.waitFor(() => expect(server.waiting).toHaveLength(1))
    server.waiting[0].resolve('ztunnel handles L4')
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2))
    engine.stop()
    expect(server.callTool).toHaveBeenCalledTimes(1)
    // the shared request used one slot only, so the limit of 1 refused nothing
    expect(toolMessages(chat, 1).map(m => m.content)).toEqual(['ztunnel handles L4', `${EARLIER_LOOKUP}\nztunnel handles L4`])
  })

  it('a later turn gets the kept result of a parallel lookup without calling the server', async () => {
    let clock = 0
    const chat = vi.fn<ChatFn>()
      .mockResolvedValueOnce({ content: null, tool_calls: [call('1', 'a'), call('2', 'b')] })
      .mockResolvedValueOnce({ content: '{"bullets":[]}' })
      .mockResolvedValueOnce({ content: null, tool_calls: [call('3', 'b')] })
      .mockResolvedValueOnce({ content: '{"bullets":[]}' })
    const callTool = vi.fn(async (_n: string, args: string) => `result ${args}`)
    const engine = createBulletsEngine({ chat, tools: () => [tool], callTool, context: () => ctx, onBullets: () => {}, now: () => clock, minIntervalMs: 1000, log: () => {} })
    engine.push({ speaker: 'Them', text: 'one', startMs: 0 })
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2))
    clock = 5000
    engine.push({ speaker: 'Them', text: 'two', startMs: 5000 })
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(4))
    engine.stop()
    expect(callTool).toHaveBeenCalledTimes(2)
    expect(toolMessages(chat, 3).at(-1)?.content).toBe(`${EARLIER_LOOKUP}\nresult {"q":"b"}`)
  })
})

describe('parallel lookups in Ask (#80)', () => {
  it('runs a round together, in order, and the same call twice reaches the server once', async () => {
    const chat = vi.fn<ChatFn>()
      .mockResolvedValueOnce({ content: null, tool_calls: [call('1', 'a'), call('2', 'b'), call('3', 'a'), { id: '4', type: 'function', function: { name: 'nope', arguments: '{}' } }] })
      .mockResolvedValueOnce({ content: JSON.stringify({ answer: 'Done.' }) })
    const server = slowServer()
    const pending = answerQuestion({ chat, question: 'what about a and b?', context: ctx, lines: [], tools: [tool], call: server.callTool })
    await vi.waitFor(() => expect(server.waiting).toHaveLength(2))
    server.waiting[1].resolve('B'); server.waiting[0].resolve('A')
    expect((await pending).text).toBe('Done.')
    expect(server.callTool).toHaveBeenCalledTimes(2)
    expect(toolMessages(chat, 1).map(m => [m.tool_call_id, m.content])).toEqual([['1', 'A'], ['2', 'B'], ['3', 'A'], ['4', 'not allowed: unknown tool']])
  })

  it('a failed lookup says so and the others still answer', async () => {
    const chat = vi.fn<ChatFn>()
      .mockResolvedValueOnce({ content: null, tool_calls: [call('1', 'a'), call('2', 'b')] })
      .mockResolvedValueOnce({ content: JSON.stringify({ answer: 'Partly.' }) })
    const callTool = vi.fn(async (_n: string, args: string) => { if (args.includes('a')) throw new Error('down'); return 'B' })
    await answerQuestion({ chat, question: 'q', context: ctx, lines: [], tools: [tool], call: callTool })
    expect(toolMessages(chat, 1).map(m => m.content)).toEqual(['lookup failed', 'B'])
  })
})
