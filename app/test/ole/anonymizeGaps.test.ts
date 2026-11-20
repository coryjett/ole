// #116: the gaps a review of #109 found. Synthetic data only: Example Corp is the meeting's record; Globex Bank,
// Initech, Umbrella Group and the numbered "Vendor" names are other organisations.
import { describe, expect, it, vi } from 'vitest'
import { ANOTHER_ORG, anonymizeSource, anonymizeSourceLink, knownOrganisations, recordNames } from '../../src/main/ole/core/anonymize'
import { anonymityFor, createBulletsEngine, type ChatFn } from '../../src/main/ole/core/bullets'
import { answerQuestion } from '../../src/main/ole/core/ask'
import { createEnricher } from '../../src/main/ole/core/enrich'
import { ORGS_KEPT, prepareContext } from '../../src/main/ole/core/prepare'
import type { OleBullet, OleTool, PreparedContext } from '../../src/main/ole/core/types'

const GLOBEX_URL = 'https://crm.example.com/accounts/globex-bank/notes'
const RESULT = JSON.stringify({ results: [{ account_name: 'Globex Bank', industry: 'Financial Services', segment: 'Enterprise', link: GLOBEX_URL }] })
const matched = (over: Partial<PreparedContext> = {}): PreparedContext => ({
  meetingTitle: 'Example Corp weekly', focus: null, preparedAt: 1,
  text: '## Before you join\n- Renewal in March (account: Example Corp)', records: ['Example Corp'], ...over,
})
const tool = (name: string): OleTool => ({ name: `s__${name}`, serverId: 's', serverName: 'S', tool: name, description: '', parameters: { type: 'object' } })

describe('1. a link whose address names another organisation is dropped, whatever the label says', () => {
  const known = knownOrganisations(RESULT)
  it('drops it when the label names no organisation', () => {
    expect(anonymizeSourceLink('product notes', GLOBEX_URL, { allowed: ['Example Corp'], known })).toEqual({ source: 'product notes' })
  })
  it('decodes the address, matches any case and the name without its legal suffix', () => {
    expect(anonymizeSourceLink('notes', 'https://crm.example.com/q?a=GLOBEX%20BANK', { allowed: [], known })).toEqual({ source: 'notes' })
    expect(anonymizeSourceLink('notes', 'https://crm.example.com/a/globex_renewal', { allowed: [], known: ['Globex Corporation'] })).toEqual({ source: 'notes' })
  })
  it("keeps a link that names only the record, or no organisation; a name inside a longer word doesn't count", () => {
    const rules = { allowed: ['Example Corp'], known: [...known, 'Example Corp'] }
    expect(anonymizeSourceLink('account', 'https://crm.example.com/accounts/example-corp', rules)).toEqual({ source: 'account', url: 'https://crm.example.com/accounts/example-corp' })
    expect(anonymizeSourceLink('ticket', 'https://crm.example.com/t/42', rules)).toEqual({ source: 'ticket', url: 'https://crm.example.com/t/42' })
    expect(anonymizeSourceLink('ticket', 'https://crm.example.com/t/globexbanking', rules)).toEqual({ source: 'ticket', url: 'https://crm.example.com/t/globexbanking' })
  })
  it('bullets drop it', async () => {
    const chat = vi.fn<ChatFn>()
      .mockImplementationOnce(async () => ({ content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 's__search_accounts', arguments: '{"query":"429"}' } }] }))
      .mockImplementation(async () => ({ content: JSON.stringify({ bullets: [{ text: 'Same 429s elsewhere, fixed in 2.3', source: 'support notes', url: GLOBEX_URL }] }) }))
    let got: OleBullet[] = []
    const engine = createBulletsEngine({ chat, tools: () => [tool('search_accounts')], callTool: async () => RESULT, context: () => matched(), onBullets: b => { got = b }, now: () => 0, minIntervalMs: 1000, log: () => {} })
    engine.push({ speaker: 'Them', text: 'we keep hitting 429s', startMs: 0 })
    await vi.waitFor(() => expect(got.length).toBe(1))
    expect(got[0].source).toBe('support notes')
    expect(got[0].url).toBeUndefined()
    engine.stop()
  })
  it('Ask drops it', async () => {
    const chat = vi.fn<ChatFn>()
      .mockImplementationOnce(async () => ({ content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 's__search_accounts', arguments: '{}' } }] }))
      .mockImplementation(async () => ({ content: JSON.stringify({ answer: 'Fixed in 2.3.', source: 'support notes', url: GLOBEX_URL }) }))
    const a = await answerQuestion({ chat, question: 'was the 429 fixed?', context: matched(), lines: [], tools: [tool('search_accounts')], call: async () => RESULT })
    expect(a.source).toBe('support notes')
    expect(a.url).toBeUndefined()
  })
  it('a mid-call section drops it', async () => {
    const result = JSON.stringify({ accounts: [{ name: 'Northwind Traders', industry: 'Retail' }, { name: 'Globex Bank', link: GLOBEX_URL }] })
    const chat = vi.fn<ChatFn>()
      .mockImplementationOnce(async () => ({ content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 's__search_accounts', arguments: '{"query":"Northwind Traders"}' } }] }))
      .mockImplementation(async () => ({ content: JSON.stringify({ facts: [
        { text: 'Retail customer', source: 'support notes', url: GLOBEX_URL, quote: '"name":"Northwind Traders","industry":"Retail"' },
      ] }) }))
    const sections: string[] = []
    const e = createEnricher({ chat, tools: () => [tool('search_accounts')], callTool: async () => result, context: () => matched(), onSection: md => sections.push(md), log: () => {},
      now: () => 0, timers: { set: (fn: () => void) => { queueMicrotask(fn); return 0 }, clear: () => {} } })
    e.push({ speaker: 'Them', text: 'we also talk to Northwind Traders about this', startMs: 0 })
    await vi.waitFor(() => expect(sections.length).toBe(1))
    expect(sections[0]).toContain('support notes')
    expect(sections[0]).not.toContain('globex')
    e.stop()
  })
})

describe("2. the record's name comes from the server match's own organisation field", () => {
  const known = [{ name: 'Globex Bank' }, { name: 'Example Corp' }]
  const briefing = 'Renewal in March (account: Example Corp); Globex Bank attends'
  it('takes the organisation object next to the match, not the first organisation in the result', () => {
    const fastResult = JSON.stringify({ attendees: [{ company: 'Globex Bank' }], match: { matchedBy: 'title', account: { id: 7, name: 'Example Corp' } } })
    expect(recordNames({ fastResult, briefing, known })).toEqual(['Example Corp'])
  })
  it('reads an explicit name field beside the match, and a match cut short', () => {
    expect(recordNames({ fastResult: JSON.stringify({ matchedBy: 'calendar', accountName: 'Example Corp', partner: { name: 'Globex Bank' } }), briefing, known })).toEqual(['Example Corp'])
    expect(recordNames({ fastResult: '{"matchedBy":"title","account":{"name":"Example Corp","notes":"long text cut sh', briefing, known })).toEqual(['Example Corp'])
  })
  it('requires the name to appear in the briefing', () => {
    const fastResult = JSON.stringify({ matchedBy: 'title', account: { name: 'Umbrella Group' } })
    expect(recordNames({ fastResult, briefing: 'Globex Bank renews (account: Globex Bank)', known })).toEqual([])
  })
  it('falls back to the briefing when the match has no organisation field', () => {
    const fastResult = JSON.stringify({ matchedBy: 'title', meeting: { title: 'weekly' }, attendees: [{ company: 'Globex Bank' }] })
    expect(recordNames({ fastResult, briefing: 'Example Corp renews (account: Example Corp); Globex Bank attends', known })).toEqual(['Example Corp'])
  })
})

describe('3. only the record is allowed; title and focus corroborate it, never allow names themselves', () => {
  it("a name in the title or focus that isn't the record is still replaced", () => {
    const ctx = matched({ meetingTitle: 'Example Corp and Globex Bank sync', focus: 'Initech' })
    const rules = anonymityFor(ctx, '')
    expect(rules.allowed).toEqual(['Example Corp'])
    expect(anonymizeSource('call records: Globex Bank', rules)).toBe(`call records: ${ANOTHER_ORG}`)
    expect(anonymizeSource('account: Initech', rules)).toBe(`account: ${ANOTHER_ORG}`)
    expect(anonymizeSource('account: Example Corp', rules)).toBe('account: Example Corp')
  })
  it('allowlist hits are exact after case, whitespace and legal suffix', () => {
    expect(anonymizeSource('account: EXAMPLE   corp inc.', { allowed: ['Example Corp'], known: ['Example Corp Inc.'] })).toBe('account: EXAMPLE   corp inc.')
    expect(anonymizeSource('account: Example Corp Asia', { allowed: ['Example Corp'], known: ['Example Corp Asia'] })).toBe(`account: ${ANOTHER_ORG}`)
    // a longer allowed text no longer allows the names inside it
    expect(anonymizeSource('account: Globex Bank', { allowed: ['Example Corp and Globex Bank sync'], known: ['Globex Bank'] })).toBe(`account: ${ANOTHER_ORG}`)
  })
  it("another organisation's name inside the record's own name is left alone", () => {
    expect(anonymizeSource('account: Globex Bank', { allowed: ['Globex Bank'], known: ['Globex', 'Globex Bank'] })).toBe('account: Globex Bank')
  })
  it('the title corroborates a record the briefing names as often as another', () => {
    const known = [{ name: 'Example Corp' }, { name: 'Globex Bank' }]
    expect(recordNames({ briefing: 'Example Corp and Globex Bank', known, meetingTitle: 'Example Corp weekly' })).toEqual(['Example Corp'])
    expect(recordNames({ briefing: 'Example Corp and Globex Bank', known, focus: 'globex bank' })).toEqual(['Globex Bank'])
    expect(recordNames({ briefing: 'Example Corp and Globex Bank', known, meetingTitle: 'weekly' })).toEqual([])
  })
})

describe('4. more organisations than kept fails closed', () => {
  const many = JSON.stringify({ accounts: Array.from({ length: ORGS_KEPT + 50 }, (_, i) => ({ name: `Vendor ${i}` })) })
  const fast = (meetingTool: OleTool) => ({ tool: meetingTool, serverName: 'S', argsJson: '{}', result: JSON.stringify({ matchedBy: 'title', account: { name: 'Example Corp' } }) })
  const prepared = async () => {
    const meetingTool: OleTool = { ...tool('get_meeting_context'), name: 's__get_meeting_context' }
    const chat = vi.fn()
      .mockResolvedValueOnce({ content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 's__search_accounts', arguments: '{"q":"x"}' } }] })
      .mockResolvedValue({ content: `## Before you join\n- Renewal in March (account: Example Corp)\n- Same issue (call records: Vendor ${ORGS_KEPT + 40})` })
    return prepareContext({ chat, tools: [meetingTool, tool('search_accounts')], call: async () => many, meetingTitle: 'Weekly', source: { meetingContext: async () => fast(meetingTool) }, log: () => {} })
  }
  it('keeps the names the briefing names first, and marks the cap', async () => {
    const ctx = await prepared()
    expect(ctx.orgs?.length).toBe(ORGS_KEPT)
    expect(ctx.orgs?.map(o => o.name)).toContain(`Vendor ${ORGS_KEPT + 40}`)
    expect(ctx.orgsTruncated).toBe(true)
    expect(ctx.records).toEqual(['Example Corp'])
  })
  it('replaces every "Kind: Name" but the record when the cap was hit', async () => {
    const rules = anonymityFor(await prepared(), '')
    expect(anonymizeSource('account: 3M', rules)).toBe(`account: ${ANOTHER_ORG}`)
    expect(anonymizeSource('From call records: acme widgets; 3 Oct', rules)).toBe(`From call records: ${ANOTHER_ORG}; 3 Oct`)
    expect(anonymizeSource('account: Example Corp', rules)).toBe('account: Example Corp')
    expect(anonymizeSource('call notes: 12 Nov', rules)).toBe('call notes: 12 Nov')
    // without the cap the same label is left as it was
    expect(anonymizeSource('account: 3M', { allowed: ['Example Corp'], known: [] })).toBe('account: 3M')
  })
})

describe('5. organisation-name fields, cut-short results and bare names', () => {
  it('a name from an explicit field skips the free-text filter: digits and short names count', () => {
    expect(knownOrganisations(JSON.stringify({ accounts: [{ name: '3M' }, { company_name: 'HP' }, { org: '7-Eleven' }] })).map(o => o.name)).toEqual(['3M', 'HP', '7-Eleven'])
    expect(knownOrganisations('{"customerName":"3M","x":"cut').map(o => o.name)).toEqual(['3M'])
    expect(anonymizeSource('notes from 3M', { allowed: [], known: knownOrganisations(JSON.stringify({ account: { name: '3M' } })) })).toBe(`notes from ${ANOTHER_ORG}`)
  })
  it('placeholders are still not names', () => {
    expect(knownOrganisations(JSON.stringify({ account: { name: 'none' }, company: 'N/A' }))).toEqual([])
  })
  it('a result cut short is repaired before the regex: a nested name and its description survive', () => {
    const cut = '{"results":[{"account":{"name":"Globex Bank","industry":"Banking","segment":"Enterprise"}},{"account":{"name":"Init'
    expect(knownOrganisations(cut)).toEqual([{ name: 'Globex Bank', description: 'a large banking company' }])
  })
  it('the regex fallback catches a bare "name" under an organisation key', () => {
    const notJson = `{'trace': 1, "account": {"id": 7, "name": "Globex Bank"}, "partners": [{"name": "Initech"}]}`
    expect(knownOrganisations(notJson).map(o => o.name)).toEqual(['Globex Bank', 'Initech'])
  })
})
