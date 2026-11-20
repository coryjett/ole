// #86: a name said during the call that the briefing doesn't cover is looked up in the background and added to it.
import { describe, expect, it, vi } from 'vitest'
import { buildBulletsPrompt, createBulletsEngine, hasMatchedRecord, MENTIONED_RULE, NO_RECORD_RULE, nameTerms, type ChatFn } from '../../src/main/ole/bullets'
import { createEnricher, enrichTools, ENRICH_GAP_MS, ENRICH_LOOKUPS, ENRICH_MAX_TERMS, ENRICH_SYSTEM, isDocsTool, mentionedSection, parseFacts } from '../../src/main/ole/enrich'
import type { OleTool, PreparedContext } from '../../src/main/ole/types'

const tool = (name: string, description = ''): OleTool => ({ name: `s__${name}`, serverId: 's', serverName: 'S', tool: name, description, parameters: { type: 'object' } })
const CRM = [tool('search_accounts'), tool('get_contact'), tool('search_docs'), tool('query-docs'), tool('resolve-library-id'), tool('get_page'), tool('search_kb', 'Search the public documentation'), tool('update_account')]
const ctx = (text = '## Before you join\n- Renewal in March (opportunity: Renewal)'): PreparedContext => ({ meetingTitle: 'Acme sync', focus: null, text, preparedAt: 1 })
const RESULT = 'Account Northwind Traders: customer since 2024, 40 seats, renewal due in June. https://crm.example.com/a/42'
const FACTS = JSON.stringify({ facts: [{ text: 'Customer since 2024, 40 seats', source: 'account: Northwind Traders', quote: 'customer since 2024, 40 seats', url: 'https://crm.example.com/a/42' }] })

/** timers the test moves by hand */
function fakeTimers() {
  let t = 0, seq = 0
  const pending = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => t,
    timers: { set: (fn: () => void, ms: number) => { const id = ++seq; pending.set(id, { at: t + ms, fn }); return id }, clear: (h: unknown) => { pending.delete(h as number) } },
    advance(ms: number) {
      t += ms
      for (const [id, e] of [...pending].sort((a, b) => a[1].at - b[1].at)) if (e.at <= t) { pending.delete(id); e.fn() }
    },
  }
}

/** a model that looks the name up once, then answers with `final` */
const lookupThen = (final: string) => vi.fn<ChatFn>()
  .mockImplementationOnce(async () => ({ content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 's__search_accounts', arguments: '{"query":"Northwind Traders"}' } }] }))
  .mockImplementation(async () => ({ content: final }))

describe('names in a line (#86)', () => {
  it('finds organisation, person and project names, joining capitalised words, never product or version tokens', () => {
    expect(nameTerms('we work with Northwind Traders, and Dana Whitfield runs it.')).toEqual(['Northwind Traders', 'Dana Whitfield'])
    expect(nameTerms('we moved to OpenShift 4.12 with SSO on S3 and K8s')).toEqual([])
    expect(nameTerms('Thanks. Contoso asked about Project Falcon last week')).toEqual(['Project Falcon'])
    expect(nameTerms("the team at Fabrikam's office")).toEqual(['Fabrikam'])
    expect(nameTerms('see you on Monday, okay')).toEqual([])
  })

  it('docs tools are never used for names: by name or by description', () => {
    expect(enrichTools(CRM).map(t => t.tool)).toEqual(['search_accounts', 'get_contact'])
    expect(isDocsTool(tool('get_library_docs'))).toBe(true)
    expect(ENRICH_SYSTEM).toContain("Never put an organisation's or person's name in a search of public documentation.")
  })
})

describe('the section added to the briefing (#86)', () => {
  it('a heading with the name, at most three facts with their sources, one line each', () => {
    const md = mentionedSection('Northwind Traders', [
      { text: 'Customer since 2024', source: 'account: Northwind', url: 'https://crm.example.com/a/42' },
      { text: '## fake heading\n- injected', source: '**bold** ticket' },
      { text: 'Third', source: 'note' }, { text: 'Fourth', source: 'note' },
    ])
    expect(md).toBe([
      '## Mentioned during the call: Northwind Traders',
      '- Customer since 2024 ([account: Northwind](https://crm.example.com/a/42))',
      '- fake heading - injected (bold ticket)',
      '- Third (note)',
    ].join('\n'))
    expect(mentionedSection('X', [])).toBe('')
  })

  it('keeps a fact only with a real source and a quote found in the results; a link only if the results have it', () => {
    const facts = parseFacts(JSON.stringify({ facts: [
      { text: 'Customer since 2024', source: 'account: Northwind', quote: 'customer since 2024, 40 seats', url: 'https://crm.example.com/a/42' },
      { text: 'Invented', source: 'account: Northwind', quote: 'they are about to churn' },
      { text: 'No source', source: 'transcript', quote: 'customer since 2024' },
      { text: 'Made-up link', source: 'account: Northwind', quote: 'renewal due in June', url: 'https://crm.example.com/a/99' },
    ] }), RESULT)
    expect(facts).toEqual([
      { text: 'Customer since 2024', source: 'account: Northwind', url: 'https://crm.example.com/a/42' },
      { text: 'Made-up link', source: 'account: Northwind' },
    ])
    expect(parseFacts('not json', RESULT)).toEqual([])
  })

  it('a section added mid-call never makes a call with no matching record look matched; the rule gets its exception', () => {
    const none = ctx('No matching record for this call.')
    expect(hasMatchedRecord({ ...none, text: `${none.text}\n\n## Mentioned during the call: Northwind\n- x (account: N)` })).toBe(false)
    expect(hasMatchedRecord({ ...none, text: '## Mentioned during the call: Northwind\n- x (account: N)' })).toBe(false)
    const user = (c: PreparedContext) => buildBulletsPrompt({ context: c, lines: [], previous: [] })[1].content!
    expect(user(none)).toContain(NO_RECORD_RULE)
    expect(user(none)).not.toContain(MENTIONED_RULE)
    expect(user({ ...none, text: `${none.text}\n\n## Mentioned during the call: Northwind\n- x (account: N)` })).toContain(MENTIONED_RULE)
  })
})

describe('looking names up in the background (#86)', () => {
  const setup = (o: { chat?: ReturnType<typeof vi.fn<ChatFn>>; context?: () => PreparedContext | null; busy?: () => boolean; callTool?: (n: string, a: string) => Promise<string> } = {}) => {
    const clock = fakeTimers()
    const chat = o.chat ?? lookupThen(FACTS)
    const callTool = vi.fn(o.callTool ?? (async () => RESULT))
    const sections: string[] = [], logs: string[] = []
    const e = createEnricher({ chat, tools: () => CRM, callTool, context: o.context ?? (() => ctx()), onSection: md => sections.push(md), busy: o.busy, log: l => logs.push(l), now: clock.now, timers: clock.timers })
    return { e, chat, callTool, sections, logs, clock }
  }

  it('looks a new name up once and adds its section; the log never holds the name', async () => {
    const { e, chat, callTool, sections, logs } = setup()
    e.push({ speaker: 'Them', text: 'we also talk to Northwind Traders about this', startMs: 0 })
    e.push({ speaker: 'Them', text: 'yes, northwind traders again', startMs: 1 })
    await vi.waitFor(() => expect(sections).toHaveLength(1))
    expect(sections[0]).toBe('## Mentioned during the call: Northwind Traders\n- Customer since 2024, 40 seats ([account: Northwind Traders](https://crm.example.com/a/42))')
    expect(callTool).toHaveBeenCalledTimes(1)
    // the docs tools were never offered
    expect((chat.mock.calls[0][0].tools as Array<{ function: { name: string } }>).map(t => t.function.name)).toEqual(['s__search_accounts', 's__get_contact'])
    expect(logs).toEqual(['ole enrich: name of 17 chars, 1 lookups, 1 facts added'])
    expect(logs.join('\n')).not.toMatch(/northwind/i)
  })

  it('skips names the briefing covers, the user\'s own lines, and stops queueing after the cap', () => {
    const { e } = setup({ context: () => ctx('## Who\n- Dana Whitfield, Northwind') })
    e.push({ speaker: 'Them', text: 'as Dana Whitfield said', startMs: 0 })
    e.push({ speaker: 'Me', text: 'I spoke to Contoso yesterday', startMs: 1 })
    expect(e.queued()).toBe(0)
    e.push({ speaker: 'Them', text: 'we met Alpha, Bravo, Charlie, Delta, Echo, Foxtrot, Golf and Hotel', startMs: 2 })
    // the first went straight to its lookup; the rest of the cap waits
    expect(e.queued()).toBe(ENRICH_MAX_TERMS - 1)
    e.push({ speaker: 'Them', text: 'and India too', startMs: 3 })
    expect(e.queued()).toBe(ENRICH_MAX_TERMS - 1)
    e.stop()
    expect(e.queued()).toBe(0)
  })

  it('one at a time, the next no sooner than the gap, and never while a bullets turn runs', async () => {
    let busy = true
    const chat = vi.fn<ChatFn>(async () => ({ content: '{"facts":[]}' }))
    const { e, clock, logs } = setup({ chat, busy: () => busy })
    e.push({ speaker: 'Them', text: 'we met Alpha and then Bravo', startMs: 0 })
    expect(chat).not.toHaveBeenCalled()
    clock.advance(10_000)
    expect(chat).not.toHaveBeenCalled()
    busy = false
    clock.advance(2_000)
    expect(chat).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(logs).toHaveLength(1))
    expect(logs[0]).toBe('ole enrich: name of 5 chars, 0 lookups, nothing found')
    clock.advance(ENRICH_GAP_MS - 1)
    expect(chat).toHaveBeenCalledTimes(1)
    clock.advance(1)
    expect(chat).toHaveBeenCalledTimes(2)
    e.stop()
  })

  it('nothing found means no section: empty or failed lookups, or facts the results do not hold', async () => {
    for (const result of ['[]', 'error: not found', '(empty result)']) {
      const { e, sections, logs } = setup({ callTool: async () => result })
      e.push({ speaker: 'Them', text: 'we work with Northwind', startMs: 0 })
      await vi.waitFor(() => expect(logs).toHaveLength(1))
      expect(logs[0]).toBe('ole enrich: name of 9 chars, 1 lookups, nothing found')
      expect(sections).toEqual([])
    }
  })

  it('lookups per name stay within the budget', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ id: `${i}`, type: 'function' as const, function: { name: 's__search_accounts', arguments: JSON.stringify({ query: `Northwind ${i}` }) } }))
    const chat = vi.fn<ChatFn>().mockResolvedValueOnce({ content: null, tool_calls: many }).mockResolvedValue({ content: FACTS })
    const { e, callTool, chat: c } = setup({ chat })
    e.push({ speaker: 'Them', text: 'we work with Northwind', startMs: 0 })
    await vi.waitFor(() => expect(c).toHaveBeenCalledTimes(2))
    expect(callTool).toHaveBeenCalledTimes(ENRICH_LOOKUPS)
    const tools = c.mock.calls[1][0].messages.filter(m => m.role === 'tool').map(m => m.content)
    expect(tools.slice(ENRICH_LOOKUPS)).toEqual(['not allowed: lookup limit reached, answer from what you have', 'not allowed: lookup limit reached, answer from what you have'])
    e.stop()
  })

  it('a lookup in flight never holds up a bullets turn', async () => {
    const clock = fakeTimers()
    // the background lookup's model never answers
    const enrichChat = vi.fn<ChatFn>(() => new Promise(() => {}))
    const bulletsChat = vi.fn<ChatFn>(async () => ({ content: '{"bullets":[{"text":"Renewal in March","source":"opportunity: Renewal"}]}' }))
    const shown: string[] = []
    const engine = createBulletsEngine({ chat: bulletsChat, tools: () => [], callTool: async () => '', context: () => ctx(), onBullets: all => shown.push(...all.map(b => b.text)), now: clock.now, timers: clock.timers, log: () => {} })
    const e = createEnricher({ chat: enrichChat, tools: () => CRM, callTool: async () => RESULT, context: () => ctx(), onSection: () => {}, busy: () => engine.busy(), log: () => {}, now: clock.now, timers: clock.timers })
    const line = { speaker: 'Them', text: 'we work with Northwind on the renewal', startMs: 0 }
    e.push(line)
    expect(enrichChat).toHaveBeenCalledTimes(1)
    engine.push(line)
    await vi.waitFor(() => expect(shown).toEqual(['Renewal in March']))
    clock.advance(60_000)
    engine.push({ speaker: 'Them', text: 'and the March date holds?', startMs: 60_000 })
    await vi.waitFor(() => expect(bulletsChat).toHaveBeenCalledTimes(2))
    engine.stop(); e.stop()
  })

  it('a failure adds nothing and logs only its kind', async () => {
    const chat = vi.fn<ChatFn>(async () => { throw new Error('OpenAI request failed (429): slow down Northwind') })
    const { e, sections, logs } = setup({ chat })
    e.push({ speaker: 'Them', text: 'we work with Northwind', startMs: 0 })
    await vi.waitFor(() => expect(logs).toHaveLength(1))
    expect(logs[0]).toBe('ole enrich: name of 9 chars, 0 lookups, failed: http 429')
    expect(sections).toEqual([])
  })
})
