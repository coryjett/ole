import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createBulletsEngine, buildBulletsPrompt, callKey } from '../../src/main/ole/core/bullets'
import type { CallToolFn, ChatFn, TranscriptLine } from '../../src/main/ole/core/bullets'
import type { OleTool } from '../../src/main/ole/core/types'

const tool = (name: string): OleTool => ({ name, serverId: 's', serverName: 'S', tool: name, description: `[S] ${name}`, parameters: { type: 'object', properties: { query: { type: 'string' } } } })
const TOOLS = [tool('s__search_calls'), tool('s__get_competitor')]
const tools = () => TOOLS

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
    const engine = createBulletsEngine({ minIntervalMs: 20_000,
      chat,
      tools,
      callTool: vi.fn<CallToolFn>(),
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
    const engine = createBulletsEngine({ minIntervalMs: 20_000,
      chat,
      tools,
      callTool: vi.fn(),
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

  it('tool lookup throttle across tools + dedupe on name and normalized args', async () => {
    const { now, advance } = makeEngine()
    const callTool = vi.fn<CallToolFn>().mockResolvedValue('found')
    const tc = (id: string, name: string, args: unknown) => ({ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } })
    const firstToolCalls = [
      tc('a', 's__search_calls', { query: 'Kafka latency', limit: 5 }),
      tc('b', 's__search_calls', { limit: 5, query: '  kafka   LATENCY ' }),
      tc('c', 's__get_competitor', { query: 'Kafka latency', limit: 5 }),
      tc('d', 's__delete_everything', {}),
      tc('e', 's__search_calls', { query: 'mtls' }),
      tc('f', 's__search_calls', { query: 'ambient' }),
    ]
    let chatCount = 0
    const chat = vi.fn<ChatFn>().mockImplementation(async () => {
      chatCount++
      if (chatCount === 1) return { content: null, tool_calls: firstToolCalls }
      return { content: '{"bullets":[]}' }
    })

    const engine = createBulletsEngine({ minIntervalMs: 20_000, chat, tools, callTool, context: () => null, onBullets: () => {}, now, maxLookupsPerMinute: 3 })

    engine.push(line('A', 'hello', 10))
    await advance(0)

    expect(chat).toHaveBeenCalledTimes(2)
    expect(chat.mock.calls[0][0].tools).toHaveLength(2)
    expect(callTool.mock.calls.map(c => c[0])).toEqual(['s__search_calls', 's__get_competitor', 's__search_calls'])
    expect(JSON.parse(callTool.mock.calls[0][1])).toEqual({ query: 'Kafka latency', limit: 5 })

    const byId = new Map(chat.mock.calls[1][0].messages.filter(m => m.role === 'tool').map(m => [m.tool_call_id, m.content]))
    expect(byId.get('a')).toBe('found')
    expect(byId.get('b')).toBe('(looked up earlier in this call)\nfound')
    expect(byId.get('c')).toBe('found')
    expect(byId.get('d')).toMatch(/unknown tool/)
    expect(byId.get('e')).toBe('found')
    expect(byId.get('f')).toMatch(/limit/)
  })

  it('never makes the same lookup twice in one call, even a minute later', async () => {
    const { now, advance } = makeEngine()
    const callTool = vi.fn<CallToolFn>().mockResolvedValue('found')
    const chat = vi.fn<ChatFn>().mockImplementation(async req => {
      const last = req.messages.at(-1)
      if (req.tools && last?.role !== 'tool') return { content: null, tool_calls: [{ id: `t${chat.mock.calls.length}`, type: 'function' as const, function: { name: 's__search_calls', arguments: '{"query":"mtls"}' } }] }
      return { content: '{"bullets":[]}' }
    })
    const engine = createBulletsEngine({ minIntervalMs: 20_000, chat, tools, callTool, context: () => null, onBullets: () => {}, now })
    engine.push(line('A', 'one', 10))
    await advance(0)
    engine.push(line('A', 'two', 70_000))
    await advance(70_000)
    expect(chat).toHaveBeenCalledTimes(4)
    expect(callTool).toHaveBeenCalledTimes(1)
  })

  it('offers no tools when there are none', async () => {
    const { now, advance } = makeEngine()
    const chat = vi.fn<ChatFn>().mockResolvedValue({ content: '{"bullets":[]}' })
    const engine = createBulletsEngine({ minIntervalMs: 20_000, chat, tools: () => [], callTool: vi.fn(), context: () => null, onBullets: () => {}, now })
    engine.push(line('A', 'hello', 10))
    await advance(0)
    expect(chat.mock.calls[0][0].tools).toBeUndefined()
  })

  it('callKey ignores key order, case and spacing', () => {
    expect(callKey('x', { b: 1, a: ' Hello  World ' })).toBe(callKey('x', { a: 'hello world', b: 1 }))
    expect(callKey('x', { a: 1 })).not.toBe(callKey('y', { a: 1 }))
  })

  it('max 2 tool rounds: chat called 3 times and 3rd call has no tools', async () => {
    const { now, advance } = makeEngine()
    let round = 0
    const callTool = vi.fn<CallToolFn>().mockResolvedValue('result')
    const chat = vi.fn<ChatFn>().mockImplementation(async () => {
      round++
      return { content: null, tool_calls: [{ id: `t${round}`, type: 'function' as const, function: { name: 's__search_calls', arguments: JSON.stringify({ query: `q${round}` }) } }] }
    })

    const engine = createBulletsEngine({ minIntervalMs: 20_000,
      chat,
      tools,
      callTool,
      context: () => null,
      onBullets: () => {},
      now,
    })

    engine.push(line('A', 'hello', 10))
    await advance(0)

    expect(chat).toHaveBeenCalledTimes(3)
    expect(callTool).toHaveBeenCalledTimes(2)
    expect(chat.mock.calls[0][0].tools).toBeDefined()
    expect(chat.mock.calls[1][0].tools).toBeDefined()
    expect(chat.mock.calls[2][0].tools).toBeUndefined()
  })

  it('sourceless dropped', async () => {
    const { now, advance } = makeEngine()
    const chat = vi.fn<ChatFn>().mockResolvedValue({
      content: JSON.stringify({ bullets: [{ text: 'has source', source: 'prepared' }, { text: 'no source', source: '' }, { text: 'missing source' }] }),
    })
    const engine = createBulletsEngine({ minIntervalMs: 20_000,
      chat,
      tools,
      callTool: vi.fn(),
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
    const engine = createBulletsEngine({ minIntervalMs: 20_000,
      chat,
      tools,
      callTool: vi.fn(),
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

    const engine = createBulletsEngine({ minIntervalMs: 20_000,
      chat,
      tools,
      callTool: vi.fn(),
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

  it('prompt includes anonymise, financial services, tools, earlier bullets and transcript format', () => {
    const messages = buildBulletsPrompt({
      context: { meetingTitle: 'Kickoff', focus: 'Acme', text: 'notes', preparedAt: 1 },
      lines: [line('Ana', 'hello', 65_000)],
      previous: [{ id: 'b1', text: 'earlier bullet', source: 's', at: 1 }],
    })
    const system = messages[0].content ?? ''
    const user = messages[1].content ?? ''
    expect(system).toMatch(/stay anonymous/i)
    expect(system).toMatch(/unless they are part of this meeting/i)
    expect(system).toMatch(/source/i)
    expect(system).toContain('financial services')
    expect(user).toContain('earlier bullet')
    expect(system).toMatch(/may call the provided tools/i)
    expect(user).toContain('Prepared context (meeting: Kickoff, focus: Acme):\nnotes')
    expect(user).toContain('[1:05] Ana: hello')
  })
})
