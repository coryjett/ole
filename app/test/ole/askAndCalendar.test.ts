import { describe, it, expect, vi } from 'vitest'
import { answerQuestion, ASK_SYSTEM, NO_ANSWER } from '../../src/main/ole/ask'
import { eventNow, pickAutoPrepare, NOW_WINDOW_MS } from '../../src/main/ole/calendarMatch'
import { protectFromCapture } from '../../src/main/ole/capture'
import type { ChatFn } from '../../src/main/ole/bullets'
import type { OleTool } from '../../src/main/ole/types'

const ctx = { meetingTitle: 'Acme', focus: null, text: 'Renewal is 1 March (opportunity: Renewal, https://crm.example/o/9)', preparedAt: 1 }
const tool: OleTool = { name: 's__search_calls', serverId: 's', serverName: 'S', tool: 'search_calls', description: 'calls', parameters: { type: 'object' } }

describe('Ask Ole (#53)', () => {
  it('answers from the briefing and keeps a link only when Ole has it', async () => {
    const chat = vi.fn<ChatFn>().mockResolvedValue({ content: JSON.stringify({ answer: 'Renewal is 1 March.', source: 'opportunity: Renewal', url: 'https://crm.example/o/9' }) })
    const a = await answerQuestion({ chat, question: 'when is the renewal?', context: ctx, lines: [], tools: [], call: vi.fn() })
    expect(a).toEqual({ text: 'Renewal is 1 March.', source: 'opportunity: Renewal', url: 'https://crm.example/o/9' })
    const sent = chat.mock.calls[0][0].messages
    expect(sent[0]).toEqual({ role: 'system', content: ASK_SYSTEM })
    expect(sent[1].content).toContain('Question: when is the renewal?')
    chat.mockResolvedValueOnce({ content: JSON.stringify({ answer: 'x', source: 'y', url: 'https://made.up/1' }) })
    expect((await answerQuestion({ chat, question: 'q', context: ctx, lines: [], tools: [], call: vi.fn() })).url).toBeUndefined()
  })

  it('may look something up, and the last round offers no tools', async () => {
    const chat = vi.fn<ChatFn>()
      .mockResolvedValueOnce({ content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 's__search_calls', arguments: '{"q":"429"}' } }] })
      .mockResolvedValueOnce({ content: JSON.stringify({ answer: 'Seen at a fintech.', source: 'call: 3 Nov' }) })
    const call = vi.fn(async () => 'call: 3 Nov, 429s')
    const a = await answerQuestion({ chat, question: 'seen 429s before?', context: null, lines: [], tools: [tool], call })
    expect(call).toHaveBeenCalledWith('s__search_calls', '{"q":"429"}')
    expect(a.text).toBe('Seen at a fintech.')
    expect(chat.mock.calls[0][0].tools).toHaveLength(1)
  })

  it('an empty or broken reply says so plainly', async () => {
    const chat = vi.fn<ChatFn>().mockResolvedValue({ content: 'not json' })
    expect((await answerQuestion({ chat, question: 'q', context: null, lines: [], tools: [], call: vi.fn() })).text).toBe(NO_ANSWER)
  })
})

const ev = (id: string, title: string, startMin: number, lenMin = 30) => ({ id, title, start: startMin * 60_000, end: (startMin + lenMin) * 60_000 })

describe('the calendar event happening now (#56)', () => {
  it('picks the event in progress or starting within 15 minutes, closest start first', () => {
    const now = 1000 * 60_000
    expect(NOW_WINDOW_MS).toBe(15 * 60_000)
    expect(eventNow([ev('a', 'Later', 1000 + 60), ev('b', 'Acme sync', 1000 + 5)], now)?.title).toBe('Acme sync')
    expect(eventNow([ev('a', 'Going', 1000 - 20, 60), ev('b', 'Soon', 1000 + 10)], now)?.title).toBe('Soon')
    expect(eventNow([ev('a', 'Tomorrow', 1000 + 24 * 60)], now)).toBeNull()
    expect(eventNow([ev('a', 'Ended', 1000 - 40)], now)).toBeNull()
    // all-day blocks are not meetings
    expect(eventNow([ev('a', 'Out of office', 1000 - 60, 24 * 60)], now)).toBeNull()
  })
})

describe('auto-prepare before calendar meetings (#52)', () => {
  it('picks the soonest meeting starting within the lead time that was not prepared yet', () => {
    const now = 1000 * 60_000
    const events = [ev('a', 'Acme sync', 1000 + 8), ev('b', 'Beta kickoff', 1000 + 4), ev('c', 'Later', 1000 + 40), ev('d', 'Started', 1000 - 5)]
    expect(pickAutoPrepare(events, now, 10 * 60_000, new Set())?.id).toBe('b')
    expect(pickAutoPrepare(events, now, 10 * 60_000, new Set(['b']))?.id).toBe('a')
    expect(pickAutoPrepare(events, now, 10 * 60_000, new Set(['a', 'b']))).toBeNull()
    expect(pickAutoPrepare([ev('x', 'Meeting', 1000 + 3)], now, 10 * 60_000, new Set())).toBeNull()
  })
})

describe('hide while sharing the screen (#51)', () => {
  it('sets content protection on every live window and skips destroyed ones', () => {
    const live = { setContentProtection: vi.fn(), isDestroyed: () => false }
    const gone = { setContentProtection: vi.fn(), isDestroyed: () => true }
    protectFromCapture([live, gone, {}], true)
    expect(live.setContentProtection).toHaveBeenCalledWith(true)
    expect(gone.setContentProtection).not.toHaveBeenCalled()
    protectFromCapture([live], false)
    expect(live.setContentProtection).toHaveBeenLastCalledWith(false)
  })
})
