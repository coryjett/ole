import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLocalChat, firstJson, localPrompt, toolMenu } from '../../src/main/ole/localChat'
import type { Llm } from '../../src/main/notes/enhance'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (n: string, f: (...a: unknown[]) => unknown) => handlers.set(n, f) },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
}))

const tool = { type: 'function', function: { name: 'crm__get_account', description: 'An account', parameters: { type: 'object', properties: { account_id: { type: 'string' } }, required: ['account_id'] } } }
const llmReplying = (...replies: string[]): Llm => {
  const chat = vi.fn(async () => replies.shift() ?? '')
  return { contextSize: 8192, count: async (t: string[]) => t.map(x => x.length / 4), chat } as unknown as Llm
}
const run = (llm: Llm) => <T,>(job: (l: Llm, s: AbortSignal) => Promise<T>) => job(llm, new AbortController().signal)

describe('Prepare on the local model (#5)', () => {
  it('lists the tools compactly with their arguments', () => {
    expect(toolMenu([tool])).toBe('- crm__get_account(account_id: string): An account')
  })
  it('a JSON tool reply becomes a tool call', async () => {
    const chat = createLocalChat(run(llmReplying('Sure. {"tool": "crm__get_account", "arguments": {"account_id": "a1"}}')))
    const r = await chat({ messages: [{ role: 'user', content: 'go' }], tools: [tool] })
    expect(r.tool_calls?.[0].function).toEqual({ name: 'crm__get_account', arguments: '{"account_id":"a1"}' })
  })
  it('a final reply is the briefing; text without JSON is taken as the briefing too', async () => {
    expect((await createLocalChat(run(llmReplying('{"final": "## Brief"}')))({ messages: [{ role: 'user', content: 'go' }], tools: [tool] })).content).toBe('## Brief')
    expect((await createLocalChat(run(llmReplying('Just text')))({ messages: [{ role: 'user', content: 'go' }], tools: [tool] })).content).toBe('Just text')
  })
  it('finds the JSON inside a code fence', () => {
    expect(firstJson('```json\n{"final": "x"}\n```')).toEqual({ final: 'x' })
  })
  it('keeps the ask and the newest turns when the context is small, and cuts long tool results', () => {
    const long = 'r'.repeat(5000)
    const messages = [{ role: 'system' as const, content: 'rules' }, { role: 'user' as const, content: 'ASK' },
      ...Array.from({ length: 30 }, (_, i) => ({ role: 'tool' as const, content: `${i}${long}`, tool_call_id: String(i) }))]
    const p = localPrompt(messages, [tool], 12000)
    expect(p).toContain('ASK')
    expect(p).toContain('29r')
    expect(p).not.toContain('0' + 'r'.repeat(10))
    expect(p.length).toBeLessThan(16000)
  })
})

describe('where Prepare runs (#5)', () => {
  it('on this Mac it runs without an OpenAI key, never during a call, and live context stays off', async () => {
    const { hookOle } = await import('../../src/main/ole/session')
    const { setProviders } = await import('../../src/main/ole/providers')
    const file = join(mkdtempSync(join(tmpdir(), 'ole-local-')), 'settings.json')
    setProviders(file, { assistant: 'local', prepareOn: 'local' })
    handlers.clear()
    const ole = hookOle({ file, send: () => {} })
    expect((await handlers.get('ole:state')!({}) as { blocked: string | null }).blocked).toContain('still starting')
    ole.setLocal(run(llmReplying('{"final": "brief"}')))
    expect((await handlers.get('ole:state')!({}) as { blocked: string | null }).blocked).toBeNull()
    ole.meetingStarted({ id: 'm1', title: 'Call' })
    expect((await handlers.get('ole:state')!({}) as { blocked: string | null }).blocked).toContain('before a call')
  })
})
