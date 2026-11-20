// #79: a question or a new term from the other side brings the next bullets turn forward to 10 s, at most once per 10 s.
import { describe, expect, it, vi } from 'vitest'
import { candidateTerms, createBulletsEngine, FAST_MIN_MS, fastTrigger, isQuestion, knownWords, type ChatFn } from '../../src/main/ole/core/bullets'
import { virtualClock } from '../../src/main/ole/core/replay'
import type { PreparedContext } from '../../src/main/ole/core/types'

describe('the trigger is pure string work (#79)', () => {
  it('questions: a question mark, or an interrogative opening (after an optional filler)', () => {
    for (const q of ['Does it support SAML?', 'what about pricing', 'How do you handle failover', 'So, can we self-host it', 'and which regions are covered', 'Is that GA yet', 'Should we start with a pilot', 'Who owns that today']) expect(isQuestion(q)).toBe(true)
    for (const q of ['We run six instances.', 'Thanks, that helps', 'Whatever works for you.', 'Domain names are fine', 'Isolation matters to us']) expect(isQuestion(q)).toBe(false)
  })

  it('terms: CamelCase, letters with digits, versions, ALLCAPS, capitalized words that do not start a sentence', () => {
    expect(candidateTerms('We moved to OpenShift and eBPF last year')).toEqual(['OpenShift', 'eBPF'])
    expect(candidateTerms('It runs on K8s with S3 and version 2.3.1')).toEqual(['K8s', 'S3', '2.3.1'])
    expect(candidateTerms('The SSO and our APIs, plus SCIM.')).toEqual(['SSO', 'APIs', 'SCIM'])
    expect(candidateTerms('we talked to Priya at Northwind about it')).toEqual(['Priya', 'Northwind'])
    // sentence starts, days, months, plain numbers, OK and I are not terms
    expect(candidateTerms('Great. Monday works, OK? I said 30 people at 10am, 3rd floor, 20% up')).toEqual([])
    expect(candidateTerms("Northwind's team")).toEqual([])
    expect(candidateTerms("our Northwind's team")).toEqual(['Northwind'])
  })

  it('a term counts only when the briefing and the bullets never mention it, and only once', () => {
    const known = knownWords('## Before you join\n- They run OpenShift 4.14 (CRM)\nEarlier bullet: Burst 429s fixed in 2.3')
    expect(fastTrigger('we also run OpenShift', known)).toBeNull()
    expect(fastTrigger('that was fixed in 2.3 I think', known)).toBeNull()
    expect(fastTrigger('we also run Nomad', known)).toEqual({ kind: 'term', term: 'nomad' })
    expect(fastTrigger('we also run Nomad', known, new Set(['nomad']))).toBeNull()
    expect(fastTrigger('does OpenShift matter?', known)).toEqual({ kind: 'question' })
  })
})

const ctx: PreparedContext = { meetingTitle: 'Sync', focus: null, text: '## Before you join\n- They run OpenShift (CRM)', preparedAt: 1 }

/** an engine on a virtual clock, answering every turn with no bullets (or the given ones), recording when turns started */
function harness(o: { fastMinMs?: number; bullets?: (turn: number) => string[] } = {}) {
  const clock = virtualClock()
  const starts: number[] = []
  const logs: string[] = []
  const chat = vi.fn<ChatFn>(async () => {
    starts.push(clock.now())
    const texts = o.bullets?.(starts.length) ?? []
    return { content: JSON.stringify({ bullets: texts.map(text => ({ text, source: 'issue #1' })) }) }
  })
  const engine = createBulletsEngine({
    chat, tools: () => [], callTool: async () => '', context: () => ctx, onBullets: () => {}, log: l => logs.push(l),
    now: clock.now, timers: clock.timers, ...(o.fastMinMs !== undefined ? { fastMinMs: o.fastMinMs } : {}),
  })
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise<void>(r => setImmediate(r)) }
  const at = async (ms: number, speaker: string, text: string) => { await clock.advanceTo(ms, settle); engine.push({ speaker, text, startMs: ms }); await settle() }
  const until = (ms: number) => clock.advanceTo(ms, settle)
  return { engine, starts, logs, at, until }
}

describe('fast turns in the engine (#79)', () => {
  it('the default rhythm stays 45 s when nothing triggers', async () => {
    const h = harness()
    await h.at(0, 'Them', 'hello there')
    await h.at(5_000, 'Them', 'we have a busy quarter')
    await h.until(60_000)
    h.engine.stop()
    expect(h.starts).toEqual([0, 45_000])
    expect(h.logs.every(l => !l.endsWith(', fast'))).toBe(true)
  })

  it('a question from the other side runs the next turn 10 s after the last, and the log says fast', async () => {
    const h = harness()
    await h.at(0, 'Them', 'hello there')
    await h.at(3_000, 'Them', 'how does failover work?')
    await h.until(60_000)
    h.engine.stop()
    expect(FAST_MIN_MS).toBe(10_000)
    expect(h.starts).toEqual([0, 10_000])
    expect(h.logs[1]).toBe('ole bullets: 0 back, 0 shown, 0 without a source, 0 repeated, 0 lookups, fast')
  })

  it('a trigger after the floor has passed runs at once; at most one fast turn per 10 s', async () => {
    const h = harness()
    await h.at(0, 'Them', 'hello there')
    await h.at(12_000, 'Them', 'what about pricing?')
    await h.at(14_000, 'Them', 'and who signs off?')
    await h.at(16_000, 'Them', 'which regions?')
    await h.until(40_000)
    h.engine.stop()
    // 12 s: at once; the next two questions wait for 22 s, one turn for both
    expect(h.starts).toEqual([0, 12_000, 22_000])
  })

  it('the user\'s own lines never bring a turn forward', async () => {
    const h = harness()
    await h.at(0, 'Them', 'hello there')
    await h.at(3_000, 'Me', 'how does failover work?')
    await h.at(4_000, 'me', 'does Nomad matter?')
    await h.until(50_000)
    h.engine.stop()
    expect(h.starts).toEqual([0, 45_000])
  })

  it('a term the briefing has does nothing; a new one triggers once, then is known', async () => {
    const h = harness()
    await h.at(0, 'Them', 'hello there')
    await h.at(3_000, 'Them', 'we run OpenShift today')
    await h.until(20_000)
    expect(h.starts).toEqual([0])
    await h.at(46_000, 'Them', 'we also run Nomad')
    await h.until(60_000)
    // the 45 s turn ran at 45 s; Nomad brings the next one to 55 s
    expect(h.starts).toEqual([0, 45_000, 55_000])
    await h.at(70_000, 'Them', 'Nomad is a pain')
    await h.until(99_000)
    expect(h.starts).toEqual([0, 45_000, 55_000])
    h.engine.stop()
  })

  it('a term an earlier bullet already named does not trigger', async () => {
    const h = harness({ bullets: n => n === 1 ? ['Nomad support ended in 3.1'] : [] })
    await h.at(0, 'Them', 'hello there')
    await h.at(3_000, 'Them', 'we also run Nomad')
    await h.until(30_000)
    h.engine.stop()
    expect(h.starts).toEqual([0])
  })

  it('fastMinMs 0 turns it off, and it is never slower than the usual rhythm', async () => {
    const off = harness({ fastMinMs: 0 })
    await off.at(0, 'Them', 'hello there')
    await off.at(3_000, 'Them', 'how does failover work?')
    await off.until(50_000)
    off.engine.stop()
    expect(off.starts).toEqual([0, 45_000])

    const slow = harness({ fastMinMs: 120_000 })
    await slow.at(0, 'Them', 'hello there')
    await slow.at(3_000, 'Them', 'how does failover work?')
    await slow.until(50_000)
    slow.engine.stop()
    expect(slow.starts).toEqual([0, 45_000])
  })

  it('a trigger during a running turn makes the next one fast', async () => {
    const clock = virtualClock()
    const starts: number[] = []
    // each reply takes 6 s of call time
    const chat: ChatFn = () => { starts.push(clock.now()); return new Promise(r => clock.timers.set(() => r({ content: '{"bullets":[]}' }), 6_000)) }
    const engine = createBulletsEngine({ chat, tools: () => [], callTool: async () => '', context: () => ctx, onBullets: () => {}, log: () => {}, now: clock.now, timers: clock.timers })
    const settle = async () => { for (let i = 0; i < 5; i++) await new Promise<void>(r => setImmediate(r)) }
    engine.push({ speaker: 'Them', text: 'hello', startMs: 0 })
    await clock.advanceTo(2_000, settle)
    engine.push({ speaker: 'Them', text: 'can it run on-prem?', startMs: 2_000 })
    await clock.advanceTo(30_000, settle)
    engine.stop()
    expect(starts).toEqual([0, 10_000])
  })
})
