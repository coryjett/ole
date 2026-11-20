// #126 in the session: an unmatched call picks up who it is with from the conversation. Resolved names become choices;
// choosing one prepares for it as the live meeting's briefing and makes it the call's record; Ole picks the first
// itself a minute after it resolved, once, never on a matched call.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OleHost, OleSettings } from '../../src/main/ole/core/host'
import type { SecretName } from '../../src/main/ole/core/types'

const KNOWN = ['Globex', 'Initech']
const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
  if (name === 'get_meeting_context') {
    const said = `${args.focus ?? ''} ${args.meeting_title ?? ''}`
    const hit = KNOWN.find(k => said.includes(k))
    return hit ? JSON.stringify({ matchedBy: 'name', account: { name: hit } }) : '{"matchedBy":null}'
  }
  return '[]'
})
let openWorld: boolean | undefined = false
vi.mock('../../src/main/ole/core/mcp', async (orig) => {
  const real = await orig<typeof import('../../src/main/ole/core/mcp')>()
  return { ...real, createMcpClient: () => ({
    listTools: async () => [
      { name: 'get_meeting_context', inputSchema: { type: 'object' }, annotations: openWorld === undefined ? {} : { openWorldHint: openWorld } },
      { name: 'search_accounts', inputSchema: { type: 'object' }, annotations: openWorld === undefined ? {} : { openWorldHint: openWorld } },
    ],
    listPrompts: async () => [], getPrompt: async () => '', callTool,
  }) }
})
type Req = { messages: Array<{ role: string; content: string | null }> }
const openaiChat = vi.fn(async (req: Req) => {
  const sys = req.messages[0].content ?? ''
  if (sys.includes('surfacing short context bullets')) return { role: 'assistant', content: '{"bullets":[]}' }
  if (sys.includes('question the user typed')) return { role: 'assistant', content: JSON.stringify({ answer: 'In March.', source: 'account: Globex' }) }
  if (sys.includes('named an organization, person or project')) return { role: 'assistant', content: '{"facts":[]}' }
  if (sys.includes('running record')) return { role: 'assistant', content: '{}' }
  const ask = req.messages.find(m => m.role === 'user' && (m.content ?? '').startsWith('Now:'))?.content ?? ''
  const name = KNOWN.find(k => ask.includes(k))
  return { role: 'assistant', content: name ? `## Before you join\n- ${name} renewal in March (account: ${name})\n- ${name} wants pricing (account: ${name})` : 'No matching record for this call.\n## Topic\n- General sync' }
})
vi.mock('../../src/main/ole/core/openai', async (orig) => ({ ...(await orig<object>()), openaiChat }))

const ID = '00000000-0000-4000-8000-000000000126'
const prepares = (name?: string) => openaiChat.mock.calls.filter(c => {
  const ask = c[0].messages.find(m => m.role === 'user' && (m.content ?? '').startsWith('Now:'))?.content ?? ''
  return ask && (name ? ask.includes(`Focus: ${name}`) : true)
}).length

function fakeHost() {
  let t = 1_700_000_000_000
  const pending: Array<{ at: number; fn: () => void }> = []
  const settings: OleSettings = { oleAssistant: 'openai', oleMcpServers: [{ id: 'crm', name: 'CRM', url: 'https://crm.example/mcp', enabled: true }] }
  const secrets = new Map<SecretName, string>([['openai', 'sk-test-123456']])
  const host: OleHost = {
    settings: { get: () => settings, patch: (p) => Object.assign(settings, p) },
    secrets: { read: (n) => secrets.get(n) ?? null, write: () => {}, remove: () => {} },
    send: () => {}, files: {},
    genericTitle: (x) => /^meeting$/i.test(x.trim()),
    clock: { now: () => t, after: (ms, fn) => { pending.push({ at: t + ms, fn }) }, every: () => {} },
    log: { warn: () => {} },
  }
  /** moves the clock on and runs the timers now due */
  const advance = (ms: number) => {
    t += ms
    for (const p of pending.splice(0).filter(x => { if (x.at <= t) return true; pending.push(x); return false })) p.fn()
  }
  return { host, advance, pending }
}

beforeEach(() => { callTool.mockClear(); openaiChat.mockClear(); openWorld = false })

async function unmatchedCall() {
  const { createOleSession } = await import('../../src/main/ole/core/session')
  const h = fakeHost()
  const s = createOleSession(h.host, { checkEveryMs: 0, autoEveryMs: 0, summaryEveryMs: 0 })
  s.meetingStarted({ id: ID, title: 'Weekly sync' })
  await vi.waitFor(() => expect(s.handlers.state().prepared?.text).toContain('No matching record'), { timeout: 3000 })
  expect(s.handlers.state().matched).toBe(false)
  return { s, ...h }
}

describe('picking up the subject from the call (#126)', () => {
  it('offers names the other side said that resolve, never the user\'s own', async () => {
    const { s } = await unmatchedCall()
    s.segment({ meetingId: ID, track: 'me', text: 'I spoke with Initech last week', startMs: 0 })
    s.segment({ meetingId: ID, track: 'them', text: 'We also talked to Globex and to Umbrella about this', startMs: 1 })
    await vi.waitFor(() => expect(s.handlers.state().subjectCandidates).toEqual([{ name: 'Globex', resolved: true }]), { timeout: 3000 })
    const focuses = callTool.mock.calls.filter(c => c[0] === 'get_meeting_context').map(c => c[1].focus).filter(Boolean)
    expect(focuses).toEqual(['Globex', 'Umbrella'])
    s.meetingStopped(ID)
  })

  it('only through tools allowed to receive names (#91)', async () => {
    openWorld = true
    const { s } = await unmatchedCall()
    s.segment({ meetingId: ID, track: 'them', text: 'We also talked to Globex about this', startMs: 1 })
    await new Promise(r => setTimeout(r, 50))
    expect(callTool.mock.calls.some(c => c[1].focus === 'Globex' || c[0] === 'search_accounts')).toBe(false)
    expect(s.handlers.state().subjectCandidates).toEqual([])
    s.meetingStopped(ID)
  })

  it('choosing one prepares for it as the live meeting\'s briefing, and it becomes the call\'s record', async () => {
    const { s } = await unmatchedCall()
    // before: the call matched nothing, so a source naming an organization is anonymized (#109)
    s.segment({ meetingId: ID, track: 'them', text: 'We also talked to Globex about this', startMs: 1 })
    const before = await s.handlers.ask('When is the renewal?')
    expect(before.answers[0].source).toBeTruthy()
    expect(before.answers[0].source).not.toContain('Globex')
    await vi.waitFor(() => expect(s.handlers.state().subjectCandidates).toHaveLength(1), { timeout: 3000 })
    const st = await s.handlers.chooseSubject('Globex')
    expect(prepares('Globex')).toBe(1)
    expect(st.prepared?.focus).toBe('Globex')
    expect(st.prepared?.meetingTitle).toBe('Weekly sync')
    expect(st.matched).toBe(true)
    expect(st.subject).toEqual({ name: 'Globex', auto: false })
    // after: Globex is the call's record, so a source may name it
    const after = await s.handlers.ask('When is the renewal again?')
    expect(after.answers[0].source).toBe('account: Globex')
    s.meetingStopped(ID)
  })

  it('refuses bad input and a choice outside a call', async () => {
    const { createOleSession } = await import('../../src/main/ole/core/session')
    const s = createOleSession(fakeHost().host, { checkEveryMs: 0, autoEveryMs: 0 })
    await s.handlers.chooseSubject('Globex')
    await s.handlers.chooseSubject(42)
    expect(prepares()).toBe(0)
  })

  it('Ole picks the first resolved name itself a minute later, once; a later choice still switches', async () => {
    const { s, advance } = await unmatchedCall()
    s.segment({ meetingId: ID, track: 'them', text: 'We also talked to Globex about this', startMs: 1 })
    await vi.waitFor(() => expect(s.handlers.state().subjectCandidates).toHaveLength(1), { timeout: 3000 })
    advance(30_000)
    expect(prepares('Globex')).toBe(0)
    advance(30_000)
    await vi.waitFor(() => expect(s.handlers.state().subject).toEqual({ name: 'Globex', auto: true }), { timeout: 3000 })
    expect(prepares('Globex')).toBe(1)
    advance(120_000)
    expect(prepares('Globex')).toBe(1)
    // chips stay after Ole's own pick, and more names are still checked
    s.segment({ meetingId: ID, track: 'them', text: 'And then Initech joined us', startMs: 3 })
    await vi.waitFor(() => expect(s.handlers.state().subjectCandidates?.map(c => c.name)).toEqual(['Globex', 'Initech']), { timeout: 3000 })
    const st = await s.handlers.chooseSubject('Initech')
    expect(st.subject).toEqual({ name: 'Initech', auto: false })
    expect(st.prepared?.focus).toBe('Initech')
    s.meetingStopped(ID)
  })

  it('no pick after the user chose', async () => {
    const { s, advance } = await unmatchedCall()
    s.segment({ meetingId: ID, track: 'them', text: 'We also talked to Globex and Initech about this', startMs: 1 })
    await vi.waitFor(() => expect(s.handlers.state().subjectCandidates).toHaveLength(2), { timeout: 3000 })
    await s.handlers.chooseSubject('Initech')
    advance(60_000)
    await new Promise(r => setTimeout(r, 20))
    expect(prepares('Globex')).toBe(0)
    expect(s.handlers.state().subject).toEqual({ name: 'Initech', auto: false })
    s.meetingStopped(ID)
  })

  it('a matched call looks nothing up and never picks', async () => {
    const { createOleSession } = await import('../../src/main/ole/core/session')
    const h = fakeHost()
    const s = createOleSession(h.host, { checkEveryMs: 0, autoEveryMs: 0, summaryEveryMs: 0 })
    s.meetingStarted({ id: ID, title: 'Globex renewal' })
    await vi.waitFor(() => expect(s.handlers.state().matched).toBe(true), { timeout: 3000 })
    s.segment({ meetingId: ID, track: 'them', text: 'We also talked to Initech about this', startMs: 1 })
    await new Promise(r => setTimeout(r, 50))
    expect(callTool.mock.calls.some(c => c[1].focus === 'Initech')).toBe(false)
    expect(s.handlers.state().subjectCandidates).toEqual([])
    h.advance(120_000)
    expect(prepares('Initech')).toBe(0)
    expect(h.pending).toHaveLength(0)
    s.meetingStopped(ID)
  })
})
