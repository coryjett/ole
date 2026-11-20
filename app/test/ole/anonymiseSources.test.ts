// #109: sources name only the meeting's own organisation; any other one Ole can identify becomes a description.
// Synthetic data only: Example Corp is the meeting's record, Globex Bank and Initech are other organisations.
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ANOTHER_ORG, anonymiseSource, anonymiseSourceLink, describeOrg, kindNames, knownOrganisations, recordNames } from '../../src/main/ole/core/anonymise'
import { anonymityFor, BULLETS_SYSTEM, createBulletsEngine, SOURCE_ANONYMITY, type ChatFn } from '../../src/main/ole/core/bullets'
import { answerQuestion, ASK_SYSTEM } from '../../src/main/ole/core/ask'
import { createEnricher, ENRICH_SYSTEM, productTerm } from '../../src/main/ole/core/enrich'
import { prepareContext } from '../../src/main/ole/core/prepare'
import { OleSavedBulletsView } from '../../src/renderer/src/ole/OleSavedBullets'
import type { OleBullet, OleTool, PreparedContext } from '../../src/main/ole/core/types'

const GLOBEX = { account_name: 'Globex Bank', industry: 'Financial Services', segment: 'Enterprise', notes: 'same 429s, fixed in 2.3' }
const INITECH = { company: { name: 'Initech', employees: 120 } }
const RESULT = JSON.stringify({ results: [GLOBEX, INITECH] })
const matched = (over: Partial<PreparedContext> = {}): PreparedContext => ({
  meetingTitle: 'Example Corp weekly', focus: null, preparedAt: 1,
  text: '## Before you join\n- Renewal in March (account: Example Corp)', records: ['Example Corp'], ...over,
})
const tool = (name: string): OleTool => ({ name: `s__${name}`, serverId: 's', serverName: 'S', tool: name, description: '', parameters: { type: 'object' } })

describe('which organisations Ole can identify (#109)', () => {
  it('reads name fields from JSON results, with a description from the same record', () => {
    expect(knownOrganisations(RESULT)).toEqual([
      { name: 'Globex Bank', description: 'a large financial services company' },
      { name: 'Initech', description: 'a small company' },
    ])
  })
  it('reads name fields from a result cut short, and "Kind: Name" lines', () => {
    const cut = '{"items":[{"customerName":"Globex Bank","industry":"Banking"},{"customerName":"Init'
    expect(knownOrganisations(cut).map(o => o.name)).toEqual(['Globex Bank'])
    expect(knownOrganisations('Account: Initech\nnotes: none').map(o => o.name)).toEqual(['Initech'])
    expect(kindNames('From call records: Globex Bank; ticket #12')).toEqual(['Globex Bank'])
  })
  it('never takes dates, quarters or lower-case words after a kind as names', () => {
    expect(kindNames('call notes: 12 Nov')).toEqual([])
    expect(kindNames('call notes: Nov 12')).toEqual([])
    expect(kindNames('call notes: Q3 Review')).toEqual([])
    expect(kindNames('account: none on file')).toEqual([])
  })
  it('describes by kind and size when known, else generically', () => {
    expect(describeOrg({ industry: 'insurance', size: 'mid-sized' })).toBe('a mid-sized insurance company')
    expect(describeOrg({ industry: 'bank', size: 'large' })).toBe('a large bank')
    expect(describeOrg({ industry: 'energy', size: null })).toBe('an energy company')
    expect(describeOrg({})).toBeUndefined()
  })
})

describe('anonymiseSource (#109)', () => {
  const known = knownOrganisations(RESULT)
  it('a source naming another company becomes a description', () => {
    expect(anonymiseSource('From call records: Globex Bank', { allowed: ['Example Corp'], known })).toBe('From call records: a large financial services company')
    expect(anonymiseSource('Initech call, 3 Oct', { allowed: ['Example Corp'], known })).toBe('a small company call, 3 Oct')
  })
  it("the matched record's own name stays", () => {
    expect(anonymiseSource('account: Example Corp', { allowed: ['Example Corp'], known: [...known, 'Example Corp'] })).toBe('account: Example Corp')
    // the record with or without its legal suffix, and the name inside the meeting title
    expect(anonymiseSource('account: Example', { allowed: ['Example Corp'], known: ['Example'] })).toBe('account: Example')
    expect(anonymiseSource('account: Example Corp', { allowed: ['Example Corp weekly'], known: ['Example Corp'] })).toBe('account: Example Corp')
  })
  it('a "Kind: Name" in the label is anonymised even when no result named it', () => {
    expect(anonymiseSource('From call records: Umbrella Group', { allowed: ['Example Corp'], known: [] })).toBe(`From call records: ${ANOTHER_ORG}`)
  })
  it('matches any case, the name without its suffix, and an address-style label; the link spelling it is dropped', () => {
    expect(anonymiseSource('notes on GLOBEX BANK', { allowed: [], known })).toBe('notes on a large financial services company')
    expect(anonymiseSource('Globex renewal notes', { allowed: [], known: ['Globex Corporation'] })).toBe(`${ANOTHER_ORG} renewal notes`)
    expect(anonymiseSourceLink('crm.example.com › globex bank', 'https://crm.example.com/accounts/globex-bank', { allowed: [], known }))
      .toEqual({ source: 'crm.example.com › a large financial services company' })
    // a link that doesn't spell the name is kept
    expect(anonymiseSourceLink('call records: Globex Bank', 'https://crm.example.com/a/42', { allowed: [], known }))
      .toEqual({ source: 'call records: a large financial services company', url: 'https://crm.example.com/a/42' })
  })
  it('leaves a source with no organisation alone', () => {
    expect(anonymiseSource('ticket #4821', { allowed: [], known })).toBe('ticket #4821')
    expect(anonymiseSource('product docs', { allowed: [], known })).toBe('product docs')
  })
  it('on a call with no matching record nothing is allowed, not even the title', () => {
    const none: PreparedContext = { meetingTitle: 'Example Corp intro', focus: null, preparedAt: 1, text: 'No matching record for this call.' }
    const rules = anonymityFor(none, 'Account: Example Corp')
    expect(rules.allowed).toEqual([])
    expect(anonymiseSource('account: Example Corp', rules)).toBe(`account: ${ANOTHER_ORG}`)
  })
})

describe('the prompts carry the rule (#109)', () => {
  it('bullets, Ask and enrichment tell the model sources follow the anonymity rule', () => {
    expect(BULLETS_SYSTEM).toContain(SOURCE_ANONYMITY)
    expect(ASK_SYSTEM).toContain(SOURCE_ANONYMITY)
    expect(ENRICH_SYSTEM).toContain('Sources follow the same anonymity rule as the bullet text')
  })
})

describe('bullets and Ask enforce it (#109)', () => {
  it('bullet sources from a lookup are anonymised; the record\'s own stays', async () => {
    const chat = vi.fn<ChatFn>()
      .mockImplementationOnce(async () => ({ content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 's__search_accounts', arguments: '{"query":"429"}' } }] }))
      .mockImplementation(async () => ({ content: JSON.stringify({ bullets: [
        { text: 'Same 429s elsewhere, fixed in 2.3', source: 'From call records: Globex Bank' },
        { text: 'Renewal in March', source: 'account: Example Corp' },
      ] }) }))
    let got: OleBullet[] = []
    const engine = createBulletsEngine({ chat, tools: () => [tool('search_accounts')], callTool: async () => RESULT, context: () => matched(), onBullets: b => { got = b }, now: () => 0, minIntervalMs: 1000, log: () => {} })
    engine.push({ speaker: 'Them', text: 'we keep hitting 429s', startMs: 0 })
    await vi.waitFor(() => expect(got.length).toBe(2))
    expect(got.map(b => b.source).sort()).toEqual(['From call records: a large financial services company', 'account: Example Corp'])
    expect(engine.lookedUp()).toContain('Globex Bank')
    engine.stop()
  })
  it('an organisation Prepare saw is anonymised even when this turn looked nothing up', async () => {
    const chat = vi.fn<ChatFn>(async () => ({ content: JSON.stringify({ bullets: [{ text: 'Similar rollout went fine', source: 'Initech notes' }] }) }))
    let got: OleBullet[] = []
    const context = matched({ orgs: [{ name: 'Initech', description: 'a small company' }], text: '## Before you join\n- Rollout (account: Example Corp)\n- Similar rollout went fine (Initech notes)' })
    const engine = createBulletsEngine({ chat, tools: () => [], callTool: vi.fn(), context: () => context, onBullets: b => { got = b }, now: () => 0, minIntervalMs: 1000, log: () => {} })
    engine.push({ speaker: 'Them', text: 'how did rollouts go', startMs: 0 })
    await vi.waitFor(() => expect(got.length).toBe(1))
    expect(got[0].source).toBe('a small company notes')
    engine.stop()
  })
  it('Ask sources are anonymised too', async () => {
    const chat = vi.fn<ChatFn>()
      .mockImplementationOnce(async () => ({ content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 's__search_accounts', arguments: '{}' } }] }))
      .mockImplementation(async () => ({ content: JSON.stringify({ answer: 'Fixed in 2.3.', source: 'call records: Globex Bank' }) }))
    const a = await answerQuestion({ chat, question: 'was the 429 fixed?', context: matched(), lines: [], tools: [tool('search_accounts')], call: async () => RESULT })
    expect(a.source).toBe('call records: a large financial services company')
  })
})

describe('mid-call sections (#86, #109)', () => {
  const clock = () => { let t = 0; return { now: () => t, timers: { set: (fn: () => void) => { queueMicrotask(fn); return 0 }, clear: () => {} }, tick: (ms: number) => { t += ms } } }

  it("section sources naming a third organisation are anonymised; the looked-up name and the record's own stay", async () => {
    const result = JSON.stringify({ accounts: [{ name: 'Northwind Traders', industry: 'Retail' }, { name: 'Globex Bank', industry: 'Financial Services', segment: 'Enterprise' }] })
    const chat = vi.fn<ChatFn>()
      .mockImplementationOnce(async () => ({ content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 's__search_accounts', arguments: '{"query":"Northwind Traders"}' } }] }))
      .mockImplementation(async () => ({ content: JSON.stringify({ facts: [
        { text: 'Retail customer', source: 'account: Northwind Traders', quote: '"name":"Northwind Traders","industry":"Retail"' },
        { text: 'Referred by another customer', source: 'From call records: Globex Bank', quote: '"name":"Globex Bank","industry":"Financial Services"' },
      ] }) }))
    const sections: string[] = []
    const c = clock()
    const e = createEnricher({ chat, tools: () => [tool('search_accounts')], callTool: async () => result, context: () => matched(), onSection: md => sections.push(md), log: () => {}, now: c.now, timers: c.timers })
    e.push({ speaker: 'Them', text: 'we also talk to Northwind Traders about this', startMs: 0 })
    await vi.waitFor(() => expect(sections.length).toBe(1))
    expect(sections[0]).toContain('(account: Northwind Traders)')
    expect(sections[0]).toContain('(From call records: a large financial services company)')
    expect(sections[0]).not.toContain('Globex')
    e.stop()
  })

  it('a product term is not looked up', async () => {
    const chat = vi.fn<ChatFn>(async () => ({ content: '{"facts":[]}' }))
    const callTool = vi.fn(async () => '[]')
    const c = clock()
    const e = createEnricher({ chat, tools: () => [tool('search_accounts')], callTool, context: () => matched(), onSection: () => {}, log: () => {}, now: c.now, timers: c.timers,
      material: () => 'the fabrikam proxy config; fabrikam defaults; Fabrikam' })
    e.push({ speaker: 'Them', text: 'we put the Contoso gateway in front of it', startMs: 0 })
    e.push({ speaker: 'Them', text: 'and we are running Tailspin there now', startMs: 1 })
    e.push({ speaker: 'Them', text: 'it also sits behind Fabrikam today', startMs: 2 })
    e.push({ speaker: 'Them', text: 'it was set up with Kubernetes by then', startMs: 3 })
    expect(e.queued()).toBe(0)
    await new Promise(r => setTimeout(r, 0))
    expect(chat).not.toHaveBeenCalled()
    expect(callTool).not.toHaveBeenCalled()
    e.stop()
  })
})

describe('productTerm (#109)', () => {
  it('a product word after it, a usage verb before it, a known product, or lower/CamelCase in the material', () => {
    expect(productTerm('Contoso', { said: 'the Contoso API is slow' })).toBe(true)
    expect(productTerm('Contoso', { said: 'we upgraded to the Contoso release' })).toBe(true)
    expect(productTerm('Tailspin', { said: 'we are running Tailspin' })).toBe(true)
    expect(productTerm('Terraform')).toBe(true)
    expect(productTerm('Fabrikam', { material: 'fabrikam is set; set fabrikam; Fabrikam' })).toBe(true)
    expect(productTerm('Adatum', { material: 'enable AdaTum; adatum flags' })).toBe(true)
  })
  it('an organisation or person said plainly is not a product', () => {
    expect(productTerm('Northwind Traders', { said: 'we also talk to Northwind Traders', material: 'Northwind Traders renewed; Northwind Traders' })).toBe(false)
    expect(productTerm('Dana Whitfield', { said: 'Dana Whitfield runs it' })).toBe(false)
    expect(productTerm('Fabrikam', { material: 'Fabrikam renewed; fabrikam' })).toBe(false)
  })
})

describe('Prepare records which organisation is the meeting\'s own (#109)', () => {
  it('the server\'s match names the record; the other organisations it read are kept for later', async () => {
    const meetingTool: OleTool = { ...tool('get_meeting_context'), name: 's__get_meeting_context' }
    const searchTool = tool('search_accounts')
    const fast = { tool: meetingTool, serverName: 'S', argsJson: '{}', result: JSON.stringify({ matchedBy: 'title', account: { name: 'Example Corp', industry: 'Software' } }) }
    const chat = vi.fn()
      .mockResolvedValueOnce({ content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 's__search_accounts', arguments: '{"q":"similar"}' } }] })
      .mockResolvedValue({ content: '## Before you join\n- Renewal in March (account: Example Corp)\n- Same issue at Globex Bank (call records: Globex Bank)' })
    const ctx = await prepareContext({ chat, tools: [meetingTool, searchTool], call: async () => RESULT, meetingTitle: 'Weekly sync', source: { meetingContext: async () => fast }, log: () => {} })
    expect(ctx.records).toEqual(['Example Corp'])
    expect(ctx.orgs?.map(o => o.name)).toEqual(expect.arrayContaining(['Example Corp', 'Globex Bank', 'Initech']))
    expect(anonymiseSource('account: Example Corp', anonymityFor(ctx, ''))).toBe('account: Example Corp')
    expect(anonymiseSource('call records: Globex Bank', anonymityFor(ctx, ''))).toBe('call records: a large financial services company')
  })
  it('without a server match, the organisation the briefing names most is the record', () => {
    const known = [{ name: 'Example Corp' }, { name: 'Globex Bank' }]
    expect(recordNames({ briefing: 'Example Corp renews (account: Example Corp); Globex Bank had it too', known })).toEqual(['Example Corp'])
    expect(recordNames({ briefing: 'Example Corp and Globex Bank', known })).toEqual([])
    expect(recordNames({ briefing: 'nothing named', known })).toEqual([])
  })
})

describe('saved older bullets are left as they are (#109)', () => {
  it('the saved view shows a stored source verbatim', () => {
    const html = renderToStaticMarkup(createElement(OleSavedBulletsView, { bullets: [{ id: 'b1', text: 'old', source: 'call records: Globex Bank', at: 1 }] }))
    expect(html).toContain('call records: Globex Bank')
  })
})
