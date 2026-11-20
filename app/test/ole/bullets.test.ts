import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createBulletsEngine, buildBulletsPrompt } from '../../src/main/ole/bullets'
import type { ChatFn, SearchCallsFn, TranscriptLine } from '../../src/main/ole/bullets'

const line = (speaker: string, text: string, startMs: number): TranscriptLine => ({ speaker, text, startMs })

describe('bullets engine', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const makeEngine = () => {
    let clockNow = 1_000_000
    const now = () => clockNow
    const advance = async (ms: number) => {
      clockNow += ms
      await vi.advanceTimersByTimeAsync(ms)
    }
    return { now, advance }
  }

  it('throttle: two pushes within minIntervalMs give one chat call; after advancing 20s a second call happens', async () => {
    const { now, advance } = makeEngine()
    const chat = vi.fn<ChatFn>().mockResolvedValue({ content: '{"bullets":[]}' })
    const searchCalls = vi.fn<SearchCallsFn>()
    const engine = createBulletsEngine({
      chat,
      searchCalls,
      context: () => null,
      onBullets: () => {},
      now,
    })

    engine.push(line('A', 'hello', 10))
    await advance(0)
    expect(chat).toHaveBeenCalledTimes(1)

    engine.push(line('B', 'world', 20))
    await advance(0)
    expect(chat).toHaveBeenCalledTimes(1)

    await advance(20_000)
    expect(chat).toHaveBeenCalledTimes(2)

    await advance(60_000)
    expect(chat).toHaveBeenCalledTimes(2)
  })

  it('no overlap: pending chat prevents second call; after resolve next runs', async () => {
    const { now, advance } = makeEngine()
    let resolveChat!: (v: { content: string | null }) => void
    const chat = vi.fn<ChatFn>().mockImplementation(() => new Promise(r => { resolveChat = r }))
    const engine = createBulletsEngine({
      chat,
      searchCalls: vi.fn(),
      context: () => null,
      onBullets: () => {},
      now,
    })

    engine.push(line('A', 'one', 10))
    await advance(0)
    expect(chat).toHaveBeenCalledTimes(1)

    engine.push(line('B', 'two', 20))
    await advance(5_000)
    expect(chat).toHaveBeenCalledTimes(1)

    resolveChat({ content: '{"bullets":[]}' })
    await advance(0)
    expect(chat).toHaveBeenCalledTimes(1)

    await advance(20_000)
    expect(chat).toHaveBeenCalledTimes(2)
  })

  it('tool lookup throttle + dedupe', async () => {
    const { now, advance } = makeEngine()
    const searchCalls = vi.fn<SearchCallsFn>().mockResolvedValue('found')
    const firstToolCalls = [
      { id: 'a', type: 'function' as const, function: { name: 'search_calls', arguments: JSON.stringify({ query: 'Kafka latency' }) } },
      { id: 'b', type: 'function' as const, function: { name: 'search_calls', arguments: JSON.stringify({ query: 'Kafka latency' }) } },
      { id: 'c', type: 'function' as const, function: { name: 'search_calls', arguments: JSON.stringify({ query: 'mtls' }) } },
      { id: 'd', type: 'function' as const, function: { name: 'search_calls', arguments: JSON.stringify({ query: 'ambient' }) } },
      { id: 'e', type: 'function' as const, function: { name: 'search_calls', arguments: JSON.stringify({ query: 'x' }) } },
    ]
    let chatCount = 0
    const chat = vi.fn<ChatFn>().mockImplementation(async () => {
      chatCount++
      if (chatCount === 1) return { content: null, tool_calls: firstToolCalls }
      return { content: '{"bullets":[]}' }
    })

    const engine = createBulletsEngine({
      chat,
      searchCalls,
      context: () => null,
      onBullets: () => {},
      now,
      maxLookupsPerMinute: 3,
    })

    engine.push(line('A', 'hello', 10))
    await advance(0)

    expect(chat).toHaveBeenCalledTimes(2)
    const secondCall = chat.mock.calls[1][0]
    const toolMsgs = secondCall.messages.filter(m => m.role === 'tool')
    expect(searchCalls).toHaveBeenCalledTimes(3)
    expect(searchCalls.mock.calls.map(c => c[0])).toEqual(['Kafka latency', 'mtls', 'ambient'])

    const byId = new Map(toolMsgs.map(m => [m.tool_call_id, m.content]))
    expect(byId.get('a')).toBe('found')
    expect(byId.get('b')).toContain('not allowed')
    expect(byId.get('c')).toBe('found')
    expect(byId.get('d')).toBe('found')
    expect(byId.get('e')).toContain('not allowed')
  })

  it('max 2 tool rounds: chat called 3 times and 3rd call has no tools', async () => {
    const { now, advance } = makeEngine()
    let round = 0
    const searchCalls = vi.fn<SearchCallsFn>().mockResolvedValue('result')
    const chat = vi.fn<ChatFn>().mockImplementation(async () => {
      round++
      return { content: null, tool_calls: [{ id: `t${round}`, type: 'function' as const, function: { name: 'search_calls', arguments: JSON.stringify({ query: `q${round}` }) } }] }
    })

    const engine = createBulletsEngine({
      chat,
      searchCalls,
      context: () => null,
      onBullets: () => {},
      now,
    })

    engine.push(line('A', 'hello', 10))
    await advance(0)

    expect(chat).toHaveBeenCalledTimes(3)
    expect(searchCalls).toHaveBeenCalledTimes(2)
    expect(chat.mock.calls[0][0].tools).toBeDefined()
    expect(chat.mock.calls[1][0].tools).toBeDefined()
    expect(chat.mock.calls[2][0].tools).toBeUndefined()
  })

  it('sourceless dropped', async () => {
    const { now, advance } = makeEngine()
    const chat = vi.fn<ChatFn>().mockResolvedValue({
      content: JSON.stringify({ bullets: [{ text: 'has source', source: 'prepared' }, { text: 'no source', source: '' }, { text: 'missing source' }] }),
    })
    const engine = createBulletsEngine({
      chat,
      searchCalls: vi.fn(),
      context: () => null,
      onBullets: () => {},
      now,
    })

    engine.push(line('A', 'hello', 10))
    await advance(0)

    expect(engine.bullets()).toHaveLength(1)
    expect(engine.bullets()[0].text).toBe('has source')
  })

  it('newest first: two runs, second run bullets come first in bullets() and onBullets arg', async () => {
    const { now, advance } = makeEngine()
    let call = 0
    const chat = vi.fn<ChatFn>().mockImplementation(async () => {
      call++
      if (call === 1) return { content: '{"bullets":[{"text":"first","source":"a"}]}' }
      return { content: '{"bullets":[{"text":"second","source":"b"}]}' }
    })

    const onBullets = vi.fn()
    const engine = createBulletsEngine({
      chat,
      searchCalls: vi.fn(),
      context: () => null,
      onBullets,
      now,
    })

    engine.push(line('A', 'one', 10))
    await advance(0)
    expect(engine.bullets()[0].text).toBe('first')

    engine.push(line('B', 'two', 30_000))
    await advance(20_000)
    expect(chat).toHaveBeenCalledTimes(2)
    expect(engine.bullets().map(b => b.text)).toEqual(['second', 'first'])
    expect(onBullets.mock.calls[1][0].map((b: { text: string }) => b.text)).toEqual(['second', 'first'])
  })

  it('error swallowed: chat rejects once; after 20s advance chat is called again and bullets appear', async () => {
    const { now, advance } = makeEngine()
    let call = 0
    const chat = vi.fn<ChatFn>().mockImplementation(async () => {
      call++
      if (call === 1) throw new Error('boom')
      return { content: '{"bullets":[{"text":"ok","source":"s"}]}' }
    })

    const engine = createBulletsEngine({
      chat,
      searchCalls: vi.fn(),
      context: () => null,
      onBullets: () => {},
      now,
    })

    expect(() => engine.push(line('A', 'hello', 10))).not.toThrow()
    await advance(0)
    expect(chat).toHaveBeenCalledTimes(1)
    expect(engine.bullets()).toEqual([])

    await advance(20_000)
    expect(chat).toHaveBeenCalledTimes(2)
    expect(engine.bullets()).toHaveLength(1)
    expect(engine.bullets()[0].text).toBe('ok')
  })

  it('prompt includes anonymise, financial services, earlier bullets and transcript format', () => {
    const messages = buildBulletsPrompt({
      context: { accountId: '001', accountName: 'Acme', meetingTitle: 'Kickoff', text: 'notes', preparedAt: 1 },
      lines: [line('Ana', 'hello', 65_000)],
      previous: [{ id: 'b1', text: 'earlier bullet', source: 's', at: 1 }],
    })
    const system = messages[0].content ?? ''
    const user = messages[1].content ?? ''
    expect(system).toMatch(/anonymise/i)
    expect(system).toMatch(/never name another customer/i)
    expect(system).toMatch(/source/i)
    expect(system).toContain('financial services')
    expect(user).toContain('earlier bullet')
    expect(user).toContain('[1:05] Ana: hello')
  })
})
