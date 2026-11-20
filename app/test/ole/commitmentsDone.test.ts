// #158: a commitment carried out later in the same call is marked done, and stays apart from the open ones.
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ChatFn } from '../../src/main/ole/core/bullets'
import { callMemoryText, createCallSummarizer, EMPTY_MEMORY, fromOleNotes, LIST_MAX, parseCallMemory, savedCallMemory, SUMMARY_SYSTEM } from '../../src/main/ole/core/callSummary'
import { OleCallLists } from '../../src/renderer/src/ole/OleCallLists'
import { OleSavedBulletsView } from '../../src/renderer/src/ole/OleSavedBullets'
import type { OleCallMemory } from '../../src/main/ole/core/types'

const prev: OleCallMemory = { summary: 'S', openQuestions: [], commitments: [{ who: 'Me', what: 'Show the full tool list in the next module' }, { who: 'Dana', what: 'Share the traffic numbers' }] }
const reply = (commitments: unknown) => JSON.stringify({ summary: 'S2', openQuestions: [], commitments })

describe('reading the done flag (#158)', () => {
  it('done true marks a commitment done; false or missing reads as open', () => {
    const m = parseCallMemory(reply([{ who: 'Me', what: 'Show the full tool list in the next module', done: true }, { who: 'Dana', what: 'Share the traffic numbers', done: false }, { who: 'Me', what: 'Book the pilot' }]), prev)!
    expect(m.commitments).toEqual([
      { who: 'Me', what: 'Show the full tool list in the next module', done: true },
      { who: 'Dana', what: 'Share the traffic numbers' },
      { who: 'Me', what: 'Book the pilot' },
    ])
  })

  it('only a real true counts: a string or number flag reads as open', () => {
    const m = parseCallMemory(reply([{ who: 'A', what: 'One', done: 'true' }, { who: 'B', what: 'Two', done: 1 }]), EMPTY_MEMORY)!
    expect(m.commitments).toEqual([{ who: 'A', what: 'One' }, { who: 'B', what: 'Two' }])
  })

  it('a commitment the reply leaves out is kept as it was, never silently dropped', () => {
    const before: OleCallMemory = { ...prev, commitments: [{ ...prev.commitments[0], done: true }, prev.commitments[1]] }
    const m = parseCallMemory(reply([{ who: 'Dana', what: 'Share the traffic numbers', done: true }]), before)!
    expect(m.commitments).toEqual([{ who: 'Dana', what: 'Share the traffic numbers', done: true }, { who: 'Me', what: 'Show the full tool list in the next module', done: true }])
  })

  it('the same commitment in slightly different words or with another who is matched, not doubled', () => {
    const m = parseCallMemory(reply([{ who: '', what: 'show the full tool list in the next module.', done: true }, { who: 'Dana', what: 'Share the traffic numbers' }]), prev)!
    expect(m.commitments).toHaveLength(2)
    expect(m.commitments[0]).toEqual({ who: '', what: 'show the full tool list in the next module.', done: true })
  })

  it('done stays done when the reply omits the flag; an explicit false reopens it', () => {
    const before: OleCallMemory = { ...prev, commitments: [{ ...prev.commitments[0], done: true }] }
    expect(parseCallMemory(reply([{ who: 'Me', what: 'Show the full tool list in the next module' }]), before)!.commitments[0].done).toBe(true)
    expect(parseCallMemory(reply(['Show the full tool list in the next module']), before)!.commitments[0].done).toBe(true)
    expect(parseCallMemory(reply([{ who: 'Me', what: 'Show the full tool list in the next module', done: false }]), before)!.commitments[0].done).toBeUndefined()
  })

  it('keeps the cap: with every kept one open, new commitments give way (done ones make room first, #160)', () => {
    const full: OleCallMemory = { ...EMPTY_MEMORY, commitments: Array.from({ length: LIST_MAX }, (_, i) => ({ who: '', what: `Old ${i}` })) }
    const m = parseCallMemory(reply([{ who: '', what: 'New one' }, { who: '', what: 'Old 0' }]), full)!
    expect(m.commitments).toHaveLength(LIST_MAX)
    expect(m.commitments.map(c => c.what)).not.toContain('New one')
  })

  it('a saved record keeps done; one saved before the flag reads as open', () => {
    expect(savedCallMemory({ summary: 'S', openQuestions: [], commitments: [{ who: 'A', what: 'B', done: true }, { who: 'C', what: 'D', done: false }] })!.commitments).toEqual([{ who: 'A', what: 'B', done: true }, { who: 'C', what: 'D' }])
    const legacy = savedCallMemory(JSON.parse('{"summary":"S","openQuestions":[],"commitments":[{"who":"A","what":"B"}]}'))!
    expect(legacy.commitments).toEqual([{ who: 'A', what: 'B' }])
    expect(legacy.commitments[0].done).toBeFalsy()
  })
})

describe('the summarizer asks about done (#158)', () => {
  it('the prompt says when done is true, never to guess, and to keep it', () => {
    expect(SUMMARY_SYSTEM).toContain('"done":false')
    expect(SUMMARY_SYSTEM).toMatch(/"done": true only when the newest part of the call shows the commitment was actually carried out/)
    expect(SUMMARY_SYSTEM).toContain('Never guess')
    expect(SUMMARY_SYSTEM).toContain('stays done unless the conversation clearly reopens it')
  })

  it('sends the current commitments with their flags, and takes the reply', async () => {
    let clock = 0
    const before = { who: 'Me', what: 'Show the full tool list in the next module' }
    const chat = vi.fn<ChatFn>()
      .mockResolvedValueOnce({ content: reply([before]) })
      .mockResolvedValueOnce({ content: reply([{ ...before, done: true }]) })
    const s = createCallSummarizer({ chat, now: () => clock, everyMs: 1000 })
    clock = 1000; s.push({ speaker: 'Me', text: "I'll show the full tool list in the next module", startMs: 0 })
    await vi.waitFor(() => expect(s.memory().commitments).toEqual([before]))
    clock = 2000; s.push({ speaker: 'Me', text: 'Here is the full tool list.', startMs: 1000 })
    await vi.waitFor(() => expect(s.memory().commitments).toEqual([{ ...before, done: true }]))
    expect(chat.mock.calls[1][0].messages[1].content).toContain('Commitments so far:\n[{"who":"Me","what":"Show the full tool list in the next module","done":false}]')
    s.stop()
  })

  it('the bullets and Ask prompts list done ones apart', () => {
    const m: OleCallMemory = { ...EMPTY_MEMORY, commitments: [{ who: 'Me', what: 'Shown', done: true }, { who: '', what: 'Book the pilot' }] }
    expect(callMemoryText(m)).toBe('Commitments:\n- Book the pilot\n\nDone during the call:\n- Me: Shown')
  })
})

describe('done commitments on the Live tab (#158)', () => {
  const lists = { openQuestions: [], commitments: [{ who: 'Me', what: 'Show the tool list', done: true }, { who: 'Dana', what: 'Share the numbers' }, { who: '', what: 'Book the pilot' }] }
  it('open first, then done, checked, struck through and labeled for screen readers', () => {
    const html = renderToStaticMarkup(createElement(OleCallLists, lists))
    const order = ['Share the numbers', 'Book the pilot', 'Show the tool list'].map(t => html.indexOf(t))
    expect(order.every(i => i > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    const done = html.slice(html.indexOf('data-testid="ole-commitment-done"'))
    expect(done).toContain('<span aria-hidden="true">✓ </span><span class="sr-only">Done: </span><span class="line-through">')
    expect(html.match(/ole-commitment-open/g)).toHaveLength(2)
    expect(html.match(/ole-commitment-done/g)).toHaveLength(1)
    // the open ones carry no mark
    const open = html.slice(0, html.indexOf('data-testid="ole-commitment-done"'))
    expect(open).not.toContain('✓')
    expect(open).not.toContain('line-through')
  })

  it('a list of only done ones still shows', () => {
    expect(renderToStaticMarkup(createElement(OleCallLists, { commitments: [{ who: '', what: 'Done thing', done: true }] }))).toContain('Done thing')
  })

  it('the saved meeting shows them the same way', () => {
    const html = renderToStaticMarkup(createElement(OleSavedBulletsView, { bullets: [], call: { ...EMPTY_MEMORY, ...lists } }))
    expect(html.indexOf('Book the pilot')).toBeLessThan(html.indexOf('Show the tool list'))
    expect(html).toContain('ole-commitment-done')
  })
})

describe('the "From Ole" notes keep done apart (#158)', () => {
  it('Commitments lists the open ones; Done during the call the fulfilled ones', () => {
    const m: OleCallMemory = { ...EMPTY_MEMORY, openQuestions: ['Q?'], commitments: [{ who: 'Me', what: 'Show the tool list', done: true }, { who: '', what: 'Book the pilot' }] }
    expect(fromOleNotes(m)).toBe('## From Ole\n**Open questions**\n- Q?\n\n**Commitments**\n- Book the pilot\n\n**Done during the call**\n- Me: Show the tool list')
  })

  it('an empty section is left out', () => {
    expect(fromOleNotes({ ...EMPTY_MEMORY, commitments: [{ who: '', what: 'Shown', done: true }] })).toBe('## From Ole\n**Done during the call**\n- Shown')
    expect(fromOleNotes({ ...EMPTY_MEMORY, commitments: [{ who: '', what: 'Open' }] })).toBe('## From Ole\n**Commitments**\n- Open')
  })

  it('done items are flattened like every other item, so they cannot forge the structure', () => {
    const md = fromOleNotes({ ...EMPTY_MEMORY, commitments: [{ who: '**Me**', what: '## From Ole\n**Commitments**\n- fake', done: true }] })
    expect(md).toBe('## From Ole\n**Done during the call**\n- Me: From Ole Commitments - fake')
    expect(md.split('\n').filter(l => /^(#|\*\*)/.test(l))).toEqual(['## From Ole', '**Done during the call**'])
  })
})
