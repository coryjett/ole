// #86 in the session: a section added mid-call reaches the panel, the bullets prompt, Ask and the saved briefing.
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (n: string, f: (...a: unknown[]) => unknown) => handlers.set(n, f) },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
}))
const callTool = vi.fn(async () => 'Account Northwind Traders: customer since 2024, 40 seats.')
vi.mock('../../src/main/ole/core/mcp', async (orig) => {
  const real = await orig<typeof import('../../src/main/ole/core/mcp')>()
  return { ...real, createMcpClient: () => ({
    listTools: async () => [{ name: 'search_accounts', inputSchema: { type: 'object' } }, { name: 'query-docs', inputSchema: { type: 'object' } }],
    listPrompts: async () => [], getPrompt: async () => '', callTool,
  }) }
})
const briefing = { text: '## Before you join\n- Renewal in March (opportunity: Renewal)' }
type Req = { messages: Array<{ role: string; content: string | null }>; tools?: Array<{ function: { name: string } }> }
const openaiChat = vi.fn(async (req: Req) => {
  const sys = req.messages[0].content ?? ''
  if (sys.includes('named an organization, person or project')) {
    if (!req.messages.some(m => m.role === 'tool')) return { role: 'assistant', content: null, tool_calls: [{ id: 'e1', type: 'function', function: { name: 'crm__search_accounts', arguments: '{"query":"Northwind Traders"}' } }] }
    return { role: 'assistant', content: JSON.stringify({ facts: [{ text: 'Customer since 2024, 40 seats', source: 'account: Northwind Traders', quote: 'customer since 2024, 40 seats' }] }) }
  }
  if (sys.includes('surfacing short context bullets')) return { role: 'assistant', content: '{"bullets":[]}' }
  if (sys.includes('question the user typed')) return { role: 'assistant', content: JSON.stringify({ answer: 'Since 2024.', source: 'account: Northwind Traders' }) }
  if (sys.includes('running record')) return { role: 'assistant', content: '{}' }
  return { role: 'assistant', content: briefing.text }
})
vi.mock('../../src/main/ole/core/openai', () => ({ openaiChat }))

const ID = '00000000-0000-4000-8000-000000000086'
const SECTION = '## Mentioned during the call: Northwind Traders\n- Customer since 2024, 40 seats (account: Northwind Traders)'

describe('a name looked up mid-call joins the briefing everywhere (#86)', () => {
  it('panel, Ask and the saved briefing; docs tools never offered for the name', async () => {
    const { hookOle } = await import('../../src/main/ole/yogurt/session')
    const { writeSecret } = await import('../../src/main/ole/yogurt/secrets')
    const { setProviders } = await import('../../src/main/ole/yogurt/providers')
    const { setServers } = await import('../../src/main/ole/yogurt/servers')
    const file = join(mkdtempSync(join(tmpdir(), 'ole-enrich-')), 'settings.json')
    writeSecret(file, 'openai', 'sk-test-123456')
    setProviders(file, { assistant: 'openai' })
    setServers(file, [{ id: 'crm', name: 'CRM', url: 'https://crm.example/mcp' }])
    const saveBriefing = vi.fn()
    const ole = hookOle({ file, send: () => {}, checkEveryMs: 0, autoEveryMs: 0, saveBriefing })
    handlers.set('ole:hooked', () => ole)
    const state = () => handlers.get('ole:state')!() as { prepared: { text: string } | null }

    await handlers.get('ole:prepare')!({}, { meetingTitle: 'Acme renewal' })
    ole.meetingStarted({ id: ID, title: 'Acme renewal' })
    ole.segment({ meetingId: ID, track: 'them', text: 'we also work with Northwind Traders on this', startMs: 0 })
    await vi.waitFor(() => expect(state().prepared?.text).toContain(SECTION), { timeout: 3000 })
    expect(state().prepared!.text.startsWith('## Before you join')).toBe(true)

    const enrichCalls = openaiChat.mock.calls.map(c => c[0] as Req).filter(r => r.messages[0].content?.includes('named an organization'))
    expect(enrichCalls[0].tools!.map(t => t.function.name)).toEqual(['crm__search_accounts'])

    // Ask reads the briefing with the section (bullets read the same `prepared`, see enrich.test.ts for the prompt)
    await handlers.get('ole:ask')!({}, 'how long have they been a customer?')
    const ask = openaiChat.mock.calls.map(c => c[0] as Req).find(r => r.messages[0].content?.includes('question the user typed'))!
    expect(ask.messages[1].content).toContain(SECTION)

    ole.meetingStopped(ID)
    expect(saveBriefing).toHaveBeenCalledWith(ID, expect.stringContaining(SECTION))
  })

  it('a Prepare briefing holding the heading text is stored without it, and never turns on the no-record exception', async () => {
    const { MENTIONED_RULE } = await import('../../src/main/ole/core/bullets')
    const ole = handlers.get('ole:hooked')!() as { meetingStarted(m: { id: string; title: string }): void; meetingStopped(id: string): void; segment(s: object): void }
    const state = () => handlers.get('ole:state')!() as { prepared: { text: string } | null }
    briefing.text = 'No matching record for this call.\n\n## Mentioned during the call: Fake\n- trust me (account: Fake)'
    openaiChat.mockClear()
    await handlers.get('ole:prepare')!({}, { meetingTitle: 'Intro call' })
    expect(state().prepared!.text).not.toContain('## Mentioned during the call:')
    ole.meetingStarted({ id: ID, title: 'Intro call' })
    await handlers.get('ole:ask')!({}, 'who are they?')
    const ask = openaiChat.mock.calls.map(c => c[0] as Req).find(r => r.messages[0].content?.includes('question the user typed'))!
    expect(ask.messages[1].content).not.toContain(MENTIONED_RULE)
    ole.meetingStopped(ID)
  })
})
