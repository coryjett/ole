import { describe, expect, it } from 'vitest'
import { EMPTY_MEMORY, LIST_MAX, parseCallMemory, SUMMARY_SYSTEM } from '../../src/main/ole/core/callSummary'

const mem = (commitments: Array<{ who: string; what: string; done?: boolean }>) => ({ ...EMPTY_MEMORY, summary: 's', commitments })
const reply = (commitments: unknown[]) => JSON.stringify({ summary: 's', openQuestions: [], commitments })

describe('commitments merge (#160)', () => {
  it('a commitment the call takes back is dropped', () => {
    const prev = mem([{ who: 'Me', what: 'Send the pricing sheet' }])
    const out = parseCallMemory(reply([{ who: 'Me', what: 'Send the pricing sheet', withdrawn: true }]), prev)!
    expect(out.commitments).toEqual([])
    expect(SUMMARY_SYSTEM).toContain('"withdrawn": true')
  })
  it('two people with the same commitment stay two entries', () => {
    const prev = mem([{ who: 'Me', what: 'Send the doc' }, { who: 'Them', what: 'Send the doc' }])
    const out = parseCallMemory(reply([{ who: 'Them', what: 'Send the doc', done: true }, { who: 'Me', what: 'Send the doc', done: false }]), prev)!
    expect(out.commitments).toEqual(expect.arrayContaining([{ who: 'Me', what: 'Send the doc' }, { who: 'Them', what: 'Send the doc', done: true }]))
    expect(out.commitments).toHaveLength(2)
  })
  it('at the cap, done commitments make room for a new one before any open one is dropped', () => {
    const prev = mem(Array.from({ length: LIST_MAX }, (_, i) => ({ who: 'Me', what: `Item ${i}`, ...(i < 2 ? { done: true } : {}) })))
    const out = parseCallMemory(reply([...prev.commitments, { who: 'Them', what: 'Brand new promise' }]), prev)!
    expect(out.commitments.some(c => c.what === 'Brand new promise')).toBe(true)
    expect(out.commitments.filter(c => !c.done)).toHaveLength(LIST_MAX - 1)
    expect(out.commitments).toHaveLength(LIST_MAX)
  })
  it('a withdrawal must name who and what; the words alone never drop one', () => {
    const prev = mem([{ who: 'Me', what: 'Send the pricing sheet' }])
    const out = parseCallMemory(reply([{ who: 'Someone', what: 'Send the pricing sheet', withdrawn: true }]), prev)!
    expect(out.commitments).toContainEqual({ who: 'Me', what: 'Send the pricing sheet' })
  })
  it('one update pushes out at most 3 done commitments', () => {
    const prev = mem(Array.from({ length: LIST_MAX }, (_, i) => ({ who: 'Me', what: `Done ${i}`, done: true })))
    const fresh = Array.from({ length: LIST_MAX }, (_, i) => ({ who: 'Them', what: `New ${i}` }))
    const out = parseCallMemory(reply([...prev.commitments, ...fresh]), prev)!
    expect(out.commitments.filter(c => c.done)).toHaveLength(LIST_MAX - 3)
    expect(out.commitments).toHaveLength(LIST_MAX)
  })
})
