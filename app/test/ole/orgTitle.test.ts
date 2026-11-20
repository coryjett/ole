// #154: a title the app writes for a matched call starts with the organization; one the person set never changes.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OleHost, OleSettings } from '../../src/main/ole/core/host'
import type { PreparedContext, SecretName } from '../../src/main/ole/core/types'
import { cleanOrg, matchedOrg, titleWithOrg } from '../../src/main/ole/core/orgTitle'

describe('titleWithOrg', () => {
  it('puts the organization in front', () => {
    expect(titleWithOrg('Agent Gateway POC with Clyde and Lan', 'Example Corp')).toBe('Example Corp: Agent Gateway POC with Clyde and Lan')
  })
  it('leaves a title that already names it, in any case', () => {
    expect(titleWithOrg('Example Corp renewal', 'Example Corp')).toBe('Example Corp renewal')
    expect(titleWithOrg('pricing with example corp', 'Example Corp')).toBe('pricing with example corp')
  })
  it('legal suffixes aside: "Example" names Example Corp, and "Example Corp" names Example Corp Inc.', () => {
    expect(titleWithOrg('Example POC kickoff', 'Example Corp')).toBe('Example POC kickoff')
    expect(titleWithOrg('Example Corp POC kickoff', 'Example Corp Inc.')).toBe('Example Corp POC kickoff')
  })
  it('a name only inside another word is not a mention', () => {
    expect(titleWithOrg('Examples of rollout plans', 'Example Corp')).toBe('Example Corp: Examples of rollout plans')
  })
  it('no organization, or an empty title: unchanged', () => {
    expect(titleWithOrg('Weekly sync', '')).toBe('Weekly sync')
    expect(titleWithOrg('Weekly sync', '   ')).toBe('Weekly sync')
    expect(titleWithOrg('Weekly sync', null)).toBe('Weekly sync')
    expect(titleWithOrg('', 'Example Corp')).toBe('')
  })
  it('an organization is one line with single spaces', () => {
    expect(cleanOrg('  Example \n Corp ')).toBe('Example Corp')
    expect(cleanOrg(7)).toBe('')
    expect(cleanOrg('x'.repeat(500))).toBe('')
  })
  it('the matched organization is the record, else the focus; never the meeting title, never when unmatched', () => {
    const ctx = (o: Partial<PreparedContext>): PreparedContext => ({ meetingTitle: 'Weekly sync', focus: null, text: '## Before you join\n- x', preparedAt: 1, ...o })
    expect(matchedOrg(ctx({ records: ['Example Corp'], focus: 'Globex' }), true)).toBe('Example Corp')
    expect(matchedOrg(ctx({ focus: 'Globex' }), true)).toBe('Globex')
    expect(matchedOrg(ctx({}), true)).toBeNull()
    expect(matchedOrg(ctx({ records: ['Example Corp'] }), false)).toBeNull()
    expect(matchedOrg(null, true)).toBeNull()
  })
})

// the session, against an in-memory host
const KNOWN = ['Globex']
vi.mock('../../src/main/ole/core/mcp', async (orig) => {
  const real = await orig<typeof import('../../src/main/ole/core/mcp')>()
  return { ...real, createMcpClient: () => ({
    listTools: async () => [{ name: 'get_meeting_context', inputSchema: { type: 'object' }, annotations: { openWorldHint: false } }],
    listPrompts: async () => [], getPrompt: async () => '',
    callTool: async (_name: string, args: Record<string, unknown>) => {
      const hit = KNOWN.find(k => `${args.focus ?? ''} ${args.meeting_title ?? ''}`.includes(k))
      return hit ? JSON.stringify({ matchedBy: 'name', account: { name: hit } }) : '{"matchedBy":null}'
    },
  }) }
})
type Req = { messages: Array<{ role: string; content: string | null }> }
vi.mock('../../src/main/ole/core/openai', async (orig) => ({ ...(await orig<object>()), openaiChat: vi.fn(async (req: Req) => {
  const sys = req.messages[0].content ?? ''
  if (sys.includes('surfacing short context bullets')) return { role: 'assistant', content: '{"bullets":[]}' }
  if (sys.includes('running record')) return { role: 'assistant', content: '{}' }
  if (sys.includes('named an organization, person or project')) return { role: 'assistant', content: '{"facts":[]}' }
  const ask = req.messages.find(m => m.role === 'user' && (m.content ?? '').startsWith('Now:'))?.content ?? ''
  const name = KNOWN.find(k => ask.includes(k))
  return { role: 'assistant', content: name ? `## Before you join\n- ${name} renewal in March (account: ${name})` : 'No matching record for this call.\n## Topic\n- General sync' }
}) }))

const ID = '00000000-0000-4000-8000-000000000154'

function memoryHost(disk: Map<string, string>, o: { failSave?: boolean } = {}) {
  const settings: OleSettings = { oleAssistant: 'openai', oleMcpServers: [{ id: 'crm', name: 'CRM', url: 'https://crm.example/mcp', enabled: true }] }
  const secrets = new Map<SecretName, string>([['openai', 'sk-test-123456']])
  const warnings: string[] = []
  const host: OleHost = {
    settings: { get: () => settings, patch: (p) => Object.assign(settings, p) },
    secrets: { read: (n) => secrets.get(n) ?? null, write: () => {}, remove: () => {} },
    send: () => {},
    files: {
      saveOrg: (id, org) => { if (o.failSave) throw new Error('disk full'); disk.set(id, org) },
      loadOrg: (id) => disk.get(id) ?? null,
    },
    genericTitle: (x) => /^meeting$/i.test(x.trim()),
    clock: { now: () => 1_700_000_000_000, after: () => {}, every: () => {} },
    log: { warn: (m) => { warnings.push(m) } },
  }
  return { host, warnings }
}

async function call(title: string, disk = new Map<string, string>(), o: { failSave?: boolean } = {}) {
  const { createOleSession } = await import('../../src/main/ole/core/session')
  const h = memoryHost(disk, o)
  const s = createOleSession(h.host, { checkEveryMs: 0, autoEveryMs: 0, summaryEveryMs: 0 })
  s.meetingStarted({ id: ID, title })
  await vi.waitFor(() => expect(s.handlers.state().prepared?.text).toContain('##'), { timeout: 3000 })
  return { s, disk, ...h }
}

describe('the call\'s organization, kept with the meeting (#154)', () => {
  beforeEach(() => { vi.resetModules() })

  it('a matched call saves its organization when it stops, and a generated title gets it in front', async () => {
    const { s, disk } = await call('Globex renewal')
    expect(s.handlers.state().matchedName).toBe('Globex')
    // during the call nothing is saved and no title changes
    expect(disk.size).toBe(0)
    expect(s.generatedTitle(ID, 'Pricing with Dana')).toBe('Pricing with Dana')
    s.meetingStopped(ID)
    expect(disk.get(ID)).toBe('Globex')
    expect(s.generatedTitle(ID, 'Pricing with Dana')).toBe('Globex: Pricing with Dana')
    expect(s.generatedTitle(ID, 'Globex pricing with Dana')).toBe('Globex pricing with Dana')
  })

  it('an unmatched call saves nothing and its titles stay as they are', async () => {
    const { s, disk } = await call('Weekly sync')
    expect(s.handlers.state().matched).toBe(false)
    s.meetingStopped(ID)
    expect(disk.size).toBe(0)
    expect(s.generatedTitle(ID, 'Pricing with Dana')).toBe('Pricing with Dana')
  })

  it('after a restart the organization is read back from the saved file', async () => {
    const disk = new Map([[ID, 'Example Corp']])
    const { createOleSession } = await import('../../src/main/ole/core/session')
    const s = createOleSession(memoryHost(disk).host, { checkEveryMs: 0, autoEveryMs: 0, summaryEveryMs: 0 })
    expect(s.generatedTitle(ID, 'Agent Gateway POC with Clyde')).toBe('Example Corp: Agent Gateway POC with Clyde')
    expect(s.generatedTitle('00000000-0000-4000-8000-000000000999', 'Agent Gateway POC with Clyde')).toBe('Agent Gateway POC with Clyde')
    expect(s.generatedTitle('not-an-id', 'Agent Gateway POC with Clyde')).toBe('Agent Gateway POC with Clyde')
  })

  it('a failed save is logged and the call still ends; this session still knows the organization', async () => {
    const { s, warnings } = await call('Globex renewal', new Map(), { failSave: true })
    s.meetingStopped(ID)
    expect(warnings).toContain('saving the call\'s organization failed')
    expect(s.generatedTitle(ID, 'Pricing with Dana')).toBe('Globex: Pricing with Dana')
  })
})
