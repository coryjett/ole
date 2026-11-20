import { describe, expect, it, vi } from 'vitest'
import { buildBulletsPrompt, createBulletsEngine, type ChatFn, type ToolCall } from '../../src/main/ole/bullets'
import { answerQuestion } from '../../src/main/ole/ask'
import { createCallSummarizer, SUMMARY_SYSTEM, SUMMARY_EVERY_MS } from '../../src/main/ole/callSummary'
import type { OleTool } from '../../src/main/ole/types'

const tool: OleTool = { name: 's__search_docs', serverId: 's', serverName: 'S', tool: 'search_docs', description: 'docs', parameters: { type: 'object' } }
const call = (id: string, q: string): ToolCall => ({ id, type: 'function', function: { name: 's__search_docs', arguments: JSON.stringify({ q }) } })
const ctx = { meetingTitle: 'Sync', focus: null, text: '## Before you join\n- x (docs)', preparedAt: 1 }

describe('lookup results kept for the call (#74)', () => {
  it('a repeat lookup gets the saved result back, without calling the server or counting against the limit', async () => {
    let clock = 0
    const chat = vi.fn<ChatFn>()
      .mockResolvedValueOnce({ content: null, tool_calls: [call('1', 'ztunnel')] })
      .mockResolvedValueOnce({ content: '{"bullets":[]}' })
      .mockResolvedValueOnce({ content: null, tool_calls: [call('2', 'ZTUNNEL')] })
      .mockResolvedValueOnce({ content: '{"bullets":[]}' })
    const callTool = vi.fn(async () => 'ztunnel handles L4')
    const engine = createBulletsEngine({ chat, tools: () => [tool], callTool, context: () => ctx, onBullets: () => {}, now: () => clock, minIntervalMs: 1000, maxLookupsPerMinute: 1, log: () => {} })
    engine.push({ speaker: 'Them', text: 'how does ztunnel work', startMs: 0 })
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2))
    clock = 2000
    engine.push({ speaker: 'Them', text: 'ztunnel again please', startMs: 2000 })
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(4))
    engine.stop()
    expect(callTool).toHaveBeenCalledTimes(1)
    const toolMsg = chat.mock.calls[3][0].messages.find(m => m.role === 'tool' && m.tool_call_id === '2')
    expect(toolMsg?.content).toBe('(looked up earlier in this call)\nztunnel handles L4')
  })
})

describe('a running summary of the call (#75)', () => {
  it('is sent with each bullets turn, ahead of the recent transcript', () => {
    const msgs = buildBulletsPrompt({ context: ctx, lines: [{ speaker: 'Them', text: 'hi', startMs: 0 }], previous: [], summary: 'They asked about pricing tiers early on.' })
    const user = msgs[1].content ?? ''
    expect(user).toContain('The call so far (summary):\nThey asked about pricing tiers early on.')
    expect(user.indexOf('The call so far')).toBeLessThan(user.indexOf('Transcript (last few minutes)'))
    expect(buildBulletsPrompt({ context: ctx, lines: [], previous: [] })[1].content).not.toContain('The call so far')
  })

  it('updates every few minutes of new conversation from the previous summary and the new lines only', async () => {
    let clock = 0
    const chat = vi.fn<ChatFn>().mockResolvedValueOnce({ content: 'S1' }).mockResolvedValueOnce({ content: 'S2' })
    const s = createCallSummarizer({ chat, now: () => clock })
    s.push({ speaker: 'Them', text: 'first topic', startMs: 0 })
    expect(chat).not.toHaveBeenCalled()
    clock = SUMMARY_EVERY_MS
    s.push({ speaker: 'Me', text: 'second topic', startMs: SUMMARY_EVERY_MS })
    await vi.waitFor(() => expect(s.summary()).toBe('S1'))
    expect(chat.mock.calls[0][0].messages[0]).toEqual({ role: 'system', content: SUMMARY_SYSTEM })
    expect(chat.mock.calls[0][0].messages[1].content).toContain('first topic')
    clock = 2 * SUMMARY_EVERY_MS
    s.push({ speaker: 'Them', text: 'third topic', startMs: 2 * SUMMARY_EVERY_MS })
    await vi.waitFor(() => expect(s.summary()).toBe('S2'))
    const second = chat.mock.calls[1][0].messages[1].content ?? ''
    expect(second).toContain('Summary so far:\nS1')
    expect(second).not.toContain('first topic')
    s.stop()
  })

  it('a failed update keeps the last summary, and nothing runs after stop', async () => {
    let clock = 0
    const chat = vi.fn<ChatFn>().mockRejectedValue(new Error('429'))
    const s = createCallSummarizer({ chat, now: () => clock })
    s.push({ speaker: 'Them', text: 'a', startMs: 0 })
    clock = SUMMARY_EVERY_MS
    s.push({ speaker: 'Them', text: 'b', startMs: clock })
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1))
    expect(s.summary()).toBe('')
    s.stop()
    clock = 3 * SUMMARY_EVERY_MS
    s.push({ speaker: 'Them', text: 'c', startMs: clock })
    expect(chat).toHaveBeenCalledTimes(1)
  })
})

describe('Ask remembers the call (#75, #76)', () => {
  it('sends the running summary and the last questions and answers', async () => {
    const chat = vi.fn<ChatFn>().mockResolvedValue({ content: JSON.stringify({ answer: 'The second one is the waypoint.' }) })
    await answerQuestion({ chat, question: 'and the second one?', context: ctx, lines: [], tools: [], call: vi.fn(),
      summary: 'Two proxies came up: ztunnel and waypoint.', earlier: [{ question: 'what proxies are there?', text: 'ztunnel and waypoint.' }] })
    const user = chat.mock.calls[0][0].messages[1].content ?? ''
    expect(user).toContain('The call so far (summary):\nTwo proxies came up: ztunnel and waypoint.')
    expect(user).toContain('Earlier questions in this call:\nQ: what proxies are there?\nA: ztunnel and waypoint.')
    expect(user.indexOf('Earlier questions')).toBeLessThan(user.indexOf('Question: and the second one?'))
  })
})

describe("the user's notes and a cache-friendly order (#77)", () => {
  it('bullets get the notes, with what does not change during a call first', () => {
    const msgs = buildBulletsPrompt({
      context: ctx, lines: [{ speaker: 'Them', text: 'hi', startMs: 0 }], previous: [{ id: 'b1', text: 'Earlier', source: 'docs', at: 1 }],
      feedback: { useful: ['Good one'], notUseful: [] }, summary: 'Pricing came up.', notes: 'Follow up on SSO',
    })
    const u = msgs[1].content ?? ''
    expect(u).toContain("The user's notes so far:\nFollow up on SSO")
    const order = ['Prepared context', 'found useful on earlier calls', 'The call so far', "The user's notes", 'Earlier bullets', 'Transcript (last few minutes)'].map(k => u.indexOf(k))
    expect(order.every(i => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })
  it('long notes keep their latest part', () => {
    const notes = `${'old line\n'.repeat(400)}newest thought`
    const u = buildBulletsPrompt({ context: ctx, lines: [], previous: [], notes })[1].content ?? ''
    expect(u).toContain('newest thought')
    expect(u.length).toBeLessThan(notes.length)
  })
  it('Ask gets the notes too', async () => {
    const chat = vi.fn<ChatFn>().mockResolvedValue({ content: JSON.stringify({ answer: 'x' }) })
    await answerQuestion({ chat, question: 'q', context: ctx, lines: [], tools: [], call: vi.fn(), notes: 'Follow up on SSO' })
    expect(chat.mock.calls[0][0].messages[1].content).toContain("The user's notes so far:\nFollow up on SSO")
  })
})
