// #126: the subject resolver's decisions, pure: which heard names are checked, when Ole picks one itself, which
// tools may receive a name, and the resolver's queue (cap, dedupe, own track, waits for a Prepare, logs no names).
import { describe, expect, it, vi } from 'vitest'
import type { OleTool } from '../../src/main/ole/core/types'
import { accountSearchTools, autoPickDue, createSubjectResolver, resultNames, searchArgs, subjectTerms, SUBJECT_AUTO_PICK_MS, SUBJECT_LOOKUPS_MAX } from '../../src/main/ole/core/subject'

const line = (text: string) => ({ speaker: 'Them', text, startMs: 0 })
const tool = (t: string, o: Partial<OleTool> = {}): OleTool => ({ name: `crm__${t}`, serverId: 'crm', serverName: 'CRM', tool: t, description: '', parameters: {}, ...o })

describe('which heard names are checked (#126)', () => {
  const base = { own: false, matched: false, taken: new Set<string>() }
  it('takes names the other side says, while the briefing is unmatched', () => {
    expect(subjectTerms({ ...base, line: line('We met with Globex yesterday about it') })).toEqual(['Globex'])
  })
  it('none from the user\'s own track', () => {
    expect(subjectTerms({ ...base, own: true, line: line('We met with Globex yesterday') })).toEqual([])
  })
  it('none once the briefing has a matched record', () => {
    expect(subjectTerms({ ...base, matched: true, line: line('We met with Globex yesterday') })).toEqual([])
  })
  it('skips products and features', () => {
    expect(subjectTerms({ ...base, line: line('We are running Kubernetes and the Northwind gateway, and Globex too') })).toEqual(['Globex'])
  })
  it('each name once per call', () => {
    expect(subjectTerms({ ...base, taken: new Set(['globex']), line: line('We met with Globex and Initech') })).toEqual(['Initech'])
    expect(subjectTerms({ ...base, line: line('We met with Globex, then Globex again') })).toEqual(['Globex'])
  })
  it('at most the per-call cap', () => {
    const taken = new Set(['a1', 'b1', 'c1'])
    expect(subjectTerms({ ...base, taken, line: line('Then Globex and Initech and Umbrella called') })).toEqual(['Globex'])
    expect(subjectTerms({ ...base, taken: new Set(['a1', 'b1', 'c1', 'd1']), line: line('Then Globex called') })).toEqual([])
    expect(SUBJECT_LOOKUPS_MAX).toBe(4)
  })
})

describe('when Ole picks a subject itself (#126)', () => {
  const d = { firstResolvedAt: 1_000, now: 1_000 + SUBJECT_AUTO_PICK_MS, chosen: false, autoPicked: false, matched: false, preparing: false }
  it('a minute after the first resolved name', () => {
    expect(autoPickDue(d)).toBe(true)
    expect(autoPickDue({ ...d, now: d.now - 1 })).toBe(false)
    expect(autoPickDue({ ...d, firstResolvedAt: null })).toBe(false)
  })
  it('never after a choice, twice, on a matched call or during a Prepare', () => {
    expect(autoPickDue({ ...d, chosen: true })).toBe(false)
    expect(autoPickDue({ ...d, autoPicked: true })).toBe(false)
    expect(autoPickDue({ ...d, matched: true })).toBe(false)
    expect(autoPickDue({ ...d, preparing: true })).toBe(false)
  })
})

describe('lookups for a heard name (#126, #91)', () => {
  it('only account-style searches allowed to receive names', () => {
    const tools = [
      tool('search_accounts', { openWorld: false }), tool('search_companies'), tool('search_web_accounts', { openWorld: false }),
      tool('search_accounts_open', { openWorld: true }), tool('get_account'), tool('search_docs', { openWorld: false }),
    ]
    expect(accountSearchTools(tools).map(t => t.tool)).toEqual(['search_accounts'])
  })
  it('the name goes in the argument the schema declares', () => {
    expect(searchArgs(tool('search_accounts', { parameters: { properties: { name: {}, limit: {} } } }), 'Globex')).toEqual({ name: 'Globex' })
    expect(searchArgs(tool('search_accounts'), 'Globex')).toEqual({ query: 'Globex' })
    expect(searchArgs(tool('search_accounts', { parameters: { properties: { limit: {} } } }), 'Globex')).toEqual({})
  })
  it('a result counts only when it names the heard name', () => {
    expect(resultNames('[{"name":"Globex Inc."}]', 'Globex')).toBe(true)
    expect(resultNames('[{"name":"Initech"}]', 'Globex')).toBe(false)
    expect(resultNames('[]', 'Globex')).toBe(false)
    expect(resultNames('error: Globex not found', 'Globex')).toBe(false)
  })
})

describe('the resolver queue (#126)', () => {
  const make = (o: { matched?: () => boolean; busy?: () => boolean; resolved?: (n: string) => boolean } = {}) => {
    const resolve = vi.fn(async (n: string) => ({ resolved: o.resolved ? o.resolved(n) : true, via: 'context' as const, lookups: 1 }))
    const log = vi.fn()
    const onResolved = vi.fn()
    const set: Array<() => void> = []
    const r = createSubjectResolver({ resolve, matched: o.matched ?? (() => false), busy: o.busy, onResolved, log, now: () => 5, timers: { set: (fn) => { set.push(fn); return set.length }, clear: () => {} } })
    return { r, resolve, log, onResolved, set }
  }
  it('checks the other side\'s names once each, up to the cap, and offers the resolved ones', async () => {
    const { r, resolve, log, onResolved } = make({ resolved: n => n !== 'Initech' })
    r.push(line('We met with Globex and Initech'), false)
    r.push(line('Then Umbrella, Hooli and Pied Piper called'), false)
    r.push(line('And Globex again, with Contoso'), false)
    r.push(line('Ask Soylent about it'), true)
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(4))
    await new Promise(res => setTimeout(res, 0))
    expect(resolve.mock.calls.map(c => c[0])).toEqual(['Globex', 'Initech', 'Umbrella', 'Hooli'])
    expect(r.candidates()).toEqual([{ name: 'Globex', resolved: true }, { name: 'Umbrella', resolved: true }, { name: 'Hooli', resolved: true }])
    expect(r.firstResolvedAt()).toBe(5)
    expect(onResolved).toHaveBeenCalledTimes(3)
    // one line per name, never the name
    expect(log).toHaveBeenCalledTimes(4)
    expect(log.mock.calls.map(c => c[0]).join('\n')).not.toMatch(/Globex|Initech|Umbrella|Hooli/)
    expect(log.mock.calls[1][0]).toBe('ole subject: name of 7 chars, 1 lookups, not found')
  })
  it('looks nothing up once matched', async () => {
    const { r, resolve } = make({ matched: () => true })
    r.push(line('We met with Globex'), false)
    await new Promise(res => setTimeout(res, 0))
    expect(resolve).not.toHaveBeenCalled()
  })
  it('waits while a Prepare runs', async () => {
    let busy = true
    const { r, resolve, set } = make({ busy: () => busy })
    r.push(line('We met with Globex'), false)
    expect(resolve).not.toHaveBeenCalled()
    busy = false
    set.shift()!()
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledWith('Globex'))
  })
})
