// Ole's docked Ask (#122): the panel, Stop dropping the pending answer, a failure logged by kind only, and the host's
// conversation code back to its shape before #118.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { OLE_ASK_LABEL, OleAskPanel } from '../../src/renderer/src/ole/OleAsk'
import { OleLiveTab } from '../../src/renderer/src/ole/OleNoteTabs'
import { shownAnswers } from '../../src/renderer/src/ole/oleAskDock'
import { answerQuestion, askErrorKind } from '../../src/main/ole/core/ask'
import type { OleLiveState } from '../../src/shared/types'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (n: string, f: (...a: unknown[]) => unknown) => handlers.set(n, f) },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
}))
vi.mock('../../src/main/ole/core/mcp', async (orig) => {
  const real = await orig<typeof import('../../src/main/ole/core/mcp')>()
  return { ...real, createMcpClient: () => ({ listTools: async () => [{ name: 'get_account', inputSchema: { type: 'object' } }], listPrompts: async () => [], getPrompt: async () => '', callTool: async () => '[]' }) }
})
type Req = { messages: Array<{ role: string; content: string }>; signal?: AbortSignal }
/** how the question's chat behaves: answer, hang until aborted, hang ignoring the signal, or fail */
const askMode = { now: 'answer' as 'answer' | 'hang' | 'deaf' | 'fail' }
const askSignals: Array<AbortSignal | undefined> = []
const openaiChat = vi.fn(async (req: Req) => {
  const sys = req.messages[0].content
  if (sys.includes('surfacing short context bullets')) return { role: 'assistant', content: JSON.stringify({ bullets: [] }) }
  if (sys.includes('question the user typed')) {
    askSignals.push(req.signal)
    if (askMode.now === 'hang') return new Promise((_, reject) => req.signal?.addEventListener('abort', () => reject(req.signal!.reason), { once: true }))
    if (askMode.now === 'deaf') return new Promise(() => {})
    if (askMode.now === 'fail') throw Object.assign(new Error('OpenAI request failed (500): renewal pricing for the account'), { status: 500 })
    return { role: 'assistant', content: JSON.stringify({ answer: 'March.', source: 'opportunity: Renewal' }) }
  }
  return { role: 'assistant', content: '## Before you join\n- x' }
})
vi.mock('../../src/main/ole/core/openai', () => ({ openaiChat }))

const ID = '00000000-0000-4000-8000-000000000122'
async function setup(extra: Record<string, unknown> = {}) {
  const { hookOle } = await import('../../src/main/ole/yogurt/session')
  const { writeSecret } = await import('../../src/main/ole/yogurt/secrets')
  const { setProviders } = await import('../../src/main/ole/yogurt/providers')
  const { setServers } = await import('../../src/main/ole/yogurt/servers')
  const file = join(mkdtempSync(join(tmpdir(), 'ole-dock-')), 'settings.json')
  writeSecret(file, 'openai', 'sk-test-123456')
  setProviders(file, { assistant: 'openai' })
  setServers(file, [{ id: 'crm', name: 'CRM', url: 'https://crm.example/mcp' }])
  const saveAnswers = vi.fn()
  const ole = hookOle({ file, send: () => {}, checkEveryMs: 0, autoEveryMs: 0, saveAnswers, ...extra })
  return { ole, saveAnswers }
}
const state = () => handlers.get('ole:state')!() as OleLiveState
const ask = (q: string, rid?: string) => handlers.get('ole:ask')!({}, q, rid) as Promise<OleLiveState>
const cancel = (rid: unknown) => handlers.get('ole:ask:cancel')!({}, rid)

beforeEach(() => { openaiChat.mockClear(); askMode.now = 'answer'; askSignals.length = 0 })
afterEach(() => { vi.restoreAllMocks() })

const live = (answers: OleLiveState['answers']): OleLiveState => ({
  meetingId: ID, preparing: false, error: null, blocked: null, unavailable: [], bullets: [], openQuestions: [], commitments: [], prepared: null, answers,
})
// newest first, as the session keeps them
const three = [
  { id: 'a3', question: 'Third?', text: 'Three.', at: 3, source: 'Renewal', url: 'https://crm.example/opp/3' },
  { id: 'a2', question: 'Second?', text: 'Two.', at: 2 },
  { id: 'a1', question: 'First?', text: 'One.', at: 1, source: 'Bad', url: 'javascript:alert(1)' },
]

describe('the Ask panel (#122)', () => {
  it('says where answers come from, shows only the latest answer by default, and offers the earlier ones', () => {
    const html = renderToStaticMarkup(createElement(OleAskPanel, { state: live(three), docked: true, meetingId: ID }))
    expect(html).toContain(OLE_ASK_LABEL)
    expect(OLE_ASK_LABEL).toBe('Answers from this call and your servers')
    expect(html).toContain('data-testid="ole-ask-dock"')
    expect(html).toContain('Three.')
    expect(html).not.toContain('Two.')
    expect(html).toContain('Show 2 earlier')
    expect(html).toContain('href="https://crm.example/opp/3"')
    expect(html).toContain('data-testid="ole-ask-send"')
    expect(html).not.toContain('ole-ask-stop')
  })

  it('expanded: every answer, oldest first so the newest sits nearest the box; a non-https link is never an href', () => {
    const html = renderToStaticMarkup(createElement(OleAskPanel, { state: live(three), defaultExpanded: true }))
    expect(html.indexOf('One.')).toBeLessThan(html.indexOf('Two.'))
    expect(html.indexOf('Two.')).toBeLessThan(html.indexOf('Three.'))
    expect(html.indexOf('Three.')).toBeLessThan(html.indexOf('ole-ask-input'))
    expect(html).toContain('Show only the latest')
    expect(html).not.toContain('javascript:')
    expect(shownAnswers(three, false).map(a => a.id)).toEqual(['a3'])
    expect(shownAnswers(three, true).map(a => a.id)).toEqual(['a1', 'a2', 'a3'])
  })

  it('no answers yet: just the label and the box; a pending answer says it is looking', () => {
    const empty = renderToStaticMarkup(createElement(OleAskPanel, { state: live([]) }))
    expect(empty).not.toContain('ole-ask-answers')
    expect(empty).not.toContain('earlier')
    const pending = renderToStaticMarkup(createElement(OleAskPanel, { state: live([{ id: 'a1', question: 'Q?', text: '', at: 1, pending: true }]) }))
    expect(pending).toContain('Looking…')
  })

  it("Home's call panel keeps a box but disables it while blocked; the docked one is not shown then", () => {
    const blocked = { ...live([]), blocked: 'Add an OpenAI key' }
    expect(renderToStaticMarkup(createElement(OleAskPanel, { state: blocked, docked: true, meetingId: ID }))).toBe('')
    expect(renderToStaticMarkup(createElement(OleAskPanel, { state: blocked }))).toMatch(/data-testid="ole-ask-input"[^>]*disabled/)
  })

  it('the Live tab still lists every answer, and has no question box of its own', () => {
    const html = renderToStaticMarkup(createElement(OleLiveTab, { state: live(three) }))
    expect(html).toContain('data-testid="ole-answers"')
    for (const t of ['One.', 'Two.', 'Three.']) expect(html).toContain(t)
    expect(html).not.toContain('ole-ask-input')
  })
})

describe('Stop (#122)', () => {
  it('cancels the request through IPC: the signal reaches the chat, the pending answer is dropped and never saved', async () => {
    const { ole, saveAnswers } = await setup()
    ole.meetingStarted({ id: ID, title: 'Renewal' })
    askMode.now = 'hang'
    const asking = ask('when is the renewal?', 'r1')
    await vi.waitFor(() => expect(askSignals).toHaveLength(1))
    expect(askSignals[0]).toBeInstanceOf(AbortSignal)
    expect(state().answers).toEqual([expect.objectContaining({ question: 'when is the renewal?', pending: true })])
    cancel('r1')
    expect(askSignals[0]!.aborted).toBe(true)
    await asking
    expect(state().answers).toEqual([])
    ole.meetingStopped(ID)
    expect(saveAnswers).not.toHaveBeenCalled()
  })

  it('answers at once even when a request ignores the signal; its late result is dropped', async () => {
    const { ole } = await setup()
    ole.meetingStarted({ id: ID, title: 'Renewal' })
    askMode.now = 'deaf'
    const asking = ask('when is the renewal?', 'r2')
    await vi.waitFor(() => expect(askSignals).toHaveLength(1))
    cancel('r2')
    await asking
    expect(state().answers).toEqual([])
    ole.meetingStopped(ID)
  })

  it('the call ended while answering: Stop takes the pending answer out of the saved ones too', async () => {
    const { ole, saveAnswers } = await setup()
    ole.meetingStarted({ id: ID, title: 'Renewal' })
    await ask('first?', 'r3')
    askMode.now = 'hang'
    const asking = ask('second?', 'r4')
    await vi.waitFor(() => expect(askSignals).toHaveLength(2))
    ole.meetingStopped(ID)
    cancel('r4')
    await asking
    expect(saveAnswers.mock.lastCall![1]).toEqual([expect.objectContaining({ question: 'first?', text: 'March.' })])
  })

  it('an unknown or malformed request id cancels nothing; a question without one still answers', async () => {
    const { ole } = await setup()
    ole.meetingStarted({ id: ID, title: 'Renewal' })
    cancel('nope'); cancel({}); cancel(undefined)
    await ask('when?', 'bad id with spaces')
    await ask('again?')
    expect(state().answers.map(a => a.text)).toEqual(['March.', 'March.'])
    ole.meetingStopped(ID)
  })
})

describe('a failed call Ask (#122)', () => {
  it('logs only the kind of failure, never the message', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ole } = await setup()
    ole.meetingStarted({ id: ID, title: 'Renewal' })
    askMode.now = 'fail'
    await ask('when is the renewal?', 'r5')
    const logged = warn.mock.calls.filter(c => String(c[0]).includes('call Ask'))
    expect(logged).toEqual([['the call Ask failed (http 500)']])
    expect(JSON.stringify(warn.mock.calls)).not.toContain('renewal pricing')
    expect(state().answers[0]).toMatchObject({ text: "Couldn't answer (http 500). Try again.", ok: false })
    ole.meetingStopped(ID)
  })

  it('askErrorKind names timeout, network, http status or error', () => {
    expect(askErrorKind(Object.assign(new Error('x'), { status: 429 }))).toBe('http 429')
    expect(askErrorKind(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe('timeout')
    expect(askErrorKind(Object.assign(new Error('x'), { name: 'McpError', kind: 'timeout' }))).toBe('timeout')
    expect(askErrorKind(Object.assign(new Error('x'), { name: 'McpError', kind: 'unreachable' }))).toBe('network')
    expect(askErrorKind(new TypeError('fetch failed'))).toBe('network')
    expect(askErrorKind(new Error('secret words'))).toBe('error')
    expect(askErrorKind('a string')).toBe('error')
  })
})

describe('answerQuestion with a signal (#122)', () => {
  it('passes it to every chat and lookup, and rejects once it is aborted mid-lookup', async () => {
    const ac = new AbortController()
    const chat = vi.fn(async () => ({ content: null, tool_calls: [{ id: 't1', type: 'function' as const, function: { name: 'get_account', arguments: '{}' } }] }))
    const call = vi.fn(async (_n: string, _a: string, opts?: { signal?: AbortSignal }) => { ac.abort(); expect(opts?.signal).toBe(ac.signal); return '[]' })
    await expect(answerQuestion({ chat, question: 'q', context: null, lines: [], tools: [{ name: 'get_account', description: '', inputSchema: {} } as never], call, signal: ac.signal }))
      .rejects.toBeDefined()
    expect((chat.mock.calls[0] as unknown as [{ signal?: AbortSignal }])[0].signal).toBe(ac.signal)
    expect(chat).toHaveBeenCalledTimes(1)
  })

  it('an already stopped question never reaches the model', async () => {
    const ac = new AbortController(); ac.abort()
    const chat = vi.fn()
    await expect(answerQuestion({ chat, question: 'q', context: null, lines: [], tools: [], call: vi.fn(), signal: ac.signal })).rejects.toBeDefined()
    expect(chat).not.toHaveBeenCalled()
  })
})

describe("the host's conversation code is back to its shape before #118 (#122)", () => {
  const read = (p: string) => readFileSync(join(__dirname, '../../src', p), 'utf8')
  it('no answerFirst, no ole_source, no oleSource, no askFromChat', () => {
    expect(read('main/library/conversations.ts')).not.toMatch(/answerFirst|oleSource|Ole/)
    expect(read('main/library/store.ts')).not.toMatch(/ole_source|oleSource/)
    expect(read('renderer/src/components/AskConversation.tsx')).not.toMatch(/OleAnswerSource|oleSource|\/ole\//)
    expect(read('shared/types.ts')).not.toMatch(/oleSource/)
    expect(read('main/index.ts')).not.toMatch(/answerFirst|askFromChat/)
    expect(read('main/ole/core/session.ts')).not.toMatch(/askFromChat/)
  })
  it("the host's Ask has one Ole seam: the button handler asks oleAskTakesOver first", () => {
    const chat = read('renderer/src/components/Chat.tsx')
    expect(chat.match(/oleAskTakesOver/g)).toHaveLength(2)
    expect(chat).toContain('if (oleAskTakesOver(id)) return')
  })
})
