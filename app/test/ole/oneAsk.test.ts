// One Ask (#118): the bottom-bar Ask answers from the call during one, and falls back to the library Ask with a note.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CALL_CONTEXT_MISSING, routeAsk } from '../../src/main/ole/core/oneAsk'
import { openStore, type Store } from '../../src/main/store'
import { Library } from '../../src/main/library/store'
import { createEmbedder } from '../../src/main/library/embedder'
import { createIndexer } from '../../src/main/library/indexer'
import { hookConversations } from '../../src/main/library/conversations'
import { createQueue } from '../../src/main/notes/queue'
import { FakeEngine } from '../../src/main/notes/fake'
import type { Llm } from '../../src/main/notes/enhance'
import { OleLiveTab } from '../../src/renderer/src/ole/OleNoteTabs'
import { OleAnswerSource } from '../../src/renderer/src/ole/OleBullets'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (n: string, f: (...a: unknown[]) => unknown) => handlers.set(n, f) },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
}))
vi.mock('../../src/main/ole/core/mcp', async (orig) => {
  const real = await orig<typeof import('../../src/main/ole/core/mcp')>()
  return { ...real, createMcpClient: () => ({ listTools: async () => [{ name: 'get_account', inputSchema: { type: 'object' } }], listPrompts: async () => [], getPrompt: async () => '', callTool: async () => '[]' }) }
})
const askFails = { on: false }
const openaiChat = vi.fn(async (req: { messages: Array<{ role: string; content: string }> }) => {
  const sys = req.messages[0].content
  if (sys.includes('surfacing short context bullets')) return { role: 'assistant', content: JSON.stringify({ bullets: [] }) }
  if (sys.includes('question the user typed')) {
    if (askFails.on) throw new Error('OpenAI 500')
    return { role: 'assistant', content: JSON.stringify({ answer: 'In March.', source: 'opportunity: Renewal' }) }
  }
  return { role: 'assistant', content: '## Before you join\n- x' }
})
vi.mock('../../src/main/ole/core/openai', () => ({ openaiChat }))

const dirs: string[] = []
const stores: Store[] = []
beforeEach(() => { openaiChat.mockClear(); askFails.on = false })
afterEach(() => {
  stores.splice(0).forEach((s) => s.close())
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

const now = new Date(2026, 10, 20, 10, 0).getTime()

/** the library Ask (conversations) and a real Ole session, wired the way index.ts wires them */
async function rig(o: { assistant?: 'openai' | 'local' } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'ole-one-ask-'))
  dirs.push(d)
  const store = openStore(join(d, 'yogurt.db'))
  stores.push(store)
  const library = new Library(store.db)
  const engine = new FakeEngine()
  const embedder = createEmbedder({ engine, modelPath: () => '/m/e.gguf', id: 'fake', dims: 768 })
  const queue = createQueue({ recording: () => false, smallMac: false })
  const indexer = createIndexer({ store, library, embedder, queue })
  const m = store.createMeeting({ title: 'Renewal call', startedAt: now - 600_000, endedAt: null, eventId: null, app: null, attendees: [], state: 'recording' })
  store.addSegments([{ meetingId: m.id, track: 'them', startMs: 1000, endMs: 2000, text: 'The renewal is in March.', speaker: null }])
  const prompts: string[] = []
  const llm: Llm = {
    contextSize: 32_768, count: async (t) => t.map((x) => Math.ceil(x.length / 4)),
    chat: async (prompt, onToken) => { prompts.push(prompt); onToken('From the meeting: March.'); return 'From the meeting: March.' },
  }
  const { hookOle } = await import('../../src/main/ole/yogurt/session')
  const { writeSecret } = await import('../../src/main/ole/yogurt/secrets')
  const { setProviders } = await import('../../src/main/ole/yogurt/providers')
  const { setServers } = await import('../../src/main/ole/yogurt/servers')
  const file = join(d, 'settings.json')
  writeSecret(file, 'openai', 'sk-test-123456')
  setProviders(file, { assistant: o.assistant ?? 'openai' })
  setServers(file, [{ id: 'crm', name: 'CRM', url: 'https://crm.example/mcp' }])
  const saveAnswers = vi.fn()
  const ole = hookOle({ file, send: () => {}, checkEveryMs: 0, autoEveryMs: 0, saveAnswers })
  const chats = hookConversations({
    store, library, indexer, embedder, queue, model: { llm: async () => llm }, send: () => {}, sendList: () => {},
    waitsForMeeting: () => false, waitsForModel: () => false, now: () => now,
    answerFirst: (id, q) => ole.askFromChat(id, q),
  })
  const panel = library.current([{ kind: 'meeting', id: m.id }])
  return { store, library, chats, ole, meeting: m, panel, prompts, saveAnswers }
}
const liveAnswers = () => (handlers.get('ole:state')!() as { answers: Array<{ question: string; text: string; source?: string; pending?: boolean }> }).answers

describe('routeAsk (#118)', () => {
  it('a question about the meeting on a call goes to the call Ask while live context can run', () => {
    expect(routeAsk({ liveMeetingId: 'm1', blocked: null, meetingId: 'm1' })).toEqual({ route: 'call' })
  })
  it('blocked during the call: the library Ask, with the note', () => {
    expect(routeAsk({ liveMeetingId: 'm1', blocked: 'Add an OpenAI key', meetingId: 'm1' })).toEqual({ route: 'library', note: CALL_CONTEXT_MISSING })
  })
  it('no call, another meeting, or a question across meetings: the library Ask as before, no note', () => {
    expect(routeAsk({ liveMeetingId: null, blocked: null, meetingId: 'm1' })).toEqual({ route: 'library' })
    expect(routeAsk({ liveMeetingId: 'm1', blocked: null, meetingId: 'm2' })).toEqual({ route: 'library' })
    expect(routeAsk({ liveMeetingId: 'm1', blocked: null, meetingId: undefined })).toEqual({ route: 'library' })
    expect(routeAsk({ liveMeetingId: null, blocked: 'x', meetingId: 'm1' })).toEqual({ route: 'library' })
  })
})

describe('the bottom-bar Ask during a call (#118)', () => {
  it('is answered by the call Ask: shown in the panel with its source, listed on Live and saved with the call', async () => {
    const t = await rig()
    t.ole.meetingStarted({ id: t.meeting.id, title: 'Renewal call' })
    await t.chats.ask(t.panel, 'When is the renewal?').done
    const turn = t.chats.view(t.panel)!.turns[0]
    expect(turn).toMatchObject({ question: 'When is the renewal?', answer: 'In March.', status: 'done', oleSource: { source: 'opportunity: Renewal' } })
    // the library model was never asked
    expect(t.prompts).toHaveLength(0)
    // kept with the conversation, source included
    expect(t.library.turns(t.panel)[0]).toMatchObject({ answer: 'In March.', oleSource: { source: 'opportunity: Renewal' } })
    expect(liveAnswers()).toEqual([expect.objectContaining({ question: 'When is the renewal?', text: 'In March.', source: 'opportunity: Renewal' })])
    expect(liveAnswers()[0].pending).toBeUndefined()
    // a follow-up keeps using the call Ask, with the earlier question (#76)
    await t.chats.ask(t.panel, 'And who owns it?').done
    expect(liveAnswers().map(a => a.question)).toEqual(['And who owns it?', 'When is the renewal?'])
    const lastAsk = openaiChat.mock.calls.map(c => c[0] as { messages: Array<{ role: string; content: string }> }).filter(r => r.messages[0].content.includes('question the user typed')).at(-1)!
    expect(lastAsk.messages[1].content).toContain('Earlier questions in this call:\nQ: When is the renewal?')
    t.ole.meetingStopped(t.meeting.id)
    expect(t.saveAnswers).toHaveBeenCalledWith(t.meeting.id, [expect.objectContaining({ text: 'In March.' }), expect.objectContaining({ text: 'In March.' })])
  })

  it('a failed call Ask falls back to the library Ask with one line first, and leaves nothing on Live', async () => {
    const t = await rig()
    t.ole.meetingStarted({ id: t.meeting.id, title: 'Renewal call' })
    askFails.on = true
    await t.chats.ask(t.panel, 'When is the renewal?').done
    const turn = t.chats.view(t.panel)!.turns[0]
    expect(turn.status).toBe('done')
    expect(turn.answer).toBe(`${CALL_CONTEXT_MISSING}\n\nFrom the meeting: March.`)
    expect(turn.oleSource).toBeUndefined()
    expect(t.prompts).toHaveLength(1)
    expect(liveAnswers()).toEqual([])
  })

  it('blocked (Assistant on Local): the library Ask with the note, and no call Ask', async () => {
    const t = await rig({ assistant: 'local' })
    t.ole.meetingStarted({ id: t.meeting.id, title: 'Renewal call' })
    await t.chats.ask(t.panel, 'When is the renewal?').done
    expect(t.chats.view(t.panel)!.turns[0].answer).toBe(`${CALL_CONTEXT_MISSING}\n\nFrom the meeting: March.`)
    expect(openaiChat.mock.calls.some(c => (c[0] as { messages: Array<{ content: string }> }).messages[0].content.includes('question the user typed'))).toBe(false)
  })

  it('outside a call the library Ask is unchanged: no note, no call Ask', async () => {
    const t = await rig()
    await t.chats.ask(t.panel, 'When is the renewal?').done
    const turn = t.chats.view(t.panel)!.turns[0]
    expect(turn.answer).toBe('From the meeting: March.')
    expect(turn.oleSource).toBeUndefined()
    expect(t.prompts).toHaveLength(1)
    expect(openaiChat).not.toHaveBeenCalled()
  })

  it('a question across meetings during a call stays with the library Ask', async () => {
    const t = await rig()
    t.ole.meetingStarted({ id: t.meeting.id, title: 'Renewal call' })
    const answerFirst = vi.spyOn(t.ole, 'askFromChat')
    const { id, done } = t.chats.ask(null, 'What did we say about renewals?')
    await done
    expect(t.chats.view(id)!.turns[0].answer).not.toContain(CALL_CONTEXT_MISSING)
    expect(answerFirst).not.toHaveBeenCalled()
    expect(liveAnswers()).toEqual([])
  })
})

describe('the Ask panel and the Live tab (#118)', () => {
  it("the panel shows Ole's source, linked only when https", () => {
    expect(renderToStaticMarkup(createElement(OleAnswerSource, { source: { source: 'Renewal', url: 'https://crm.example/opp/1' } })))
      .toContain('href="https://crm.example/opp/1"')
    const plain = renderToStaticMarkup(createElement(OleAnswerSource, { source: { source: 'Renewal', url: 'javascript:alert(1)' } }))
    expect(plain).toContain('Renewal')
    expect(plain).not.toContain('href')
    expect(renderToStaticMarkup(createElement(OleAnswerSource, { source: undefined }))).toBe('')
  })

  it('the Live tab has no Ask box but lists the answers', () => {
    const state = {
      meetingId: 'm', preparing: false, error: null, blocked: null, unavailable: [], bullets: [], openQuestions: [], commitments: [], prepared: null,
      answers: [{ id: 'a1', question: 'When is the renewal?', text: 'In March.', source: 'opportunity: Renewal', at: 0 }],
    }
    const html = renderToStaticMarkup(createElement(OleLiveTab, { state }))
    expect(html).not.toContain('ole-ask')
    expect(html).toContain('data-testid="ole-answers"')
    expect(html).toContain('When is the renewal?')
    expect(html).toContain('In March.')
  })
})
