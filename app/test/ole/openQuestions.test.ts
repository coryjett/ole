// #82: the running summary is structured: summary text, questions still open, and commitments (who will do what).
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildBulletsPrompt, type ChatFn } from '../../src/main/ole/core/bullets'
import { callMemoryText, createCallSummarizer, EMPTY_MEMORY, ITEM_MAX, LIST_MAX, parseCallMemory, savedCallMemory, SUMMARY_SYSTEM } from '../../src/main/ole/core/callSummary'
import { OleCallLists } from '../../src/renderer/src/ole/OleCallLists'
import { OleSavedBulletsView } from '../../src/renderer/src/ole/OleSavedBullets'
import { LiveView } from '../../src/renderer/src/ole/OlePanel'
import type { OleCallMemory } from '../../src/main/ole/core/types'

const prev: OleCallMemory = { summary: 'Pricing came up.', openQuestions: ['Is there a free tier?'], commitments: [{ who: 'Me', what: 'Send the benchmark plan' }] }

describe('reading the record from the model (#82)', () => {
  it('takes summary, open questions and commitments', () => {
    const m = parseCallMemory(JSON.stringify({ summary: ' New summary ', openQuestions: ['Does it run on-prem?'], commitments: [{ who: 'Dana', what: 'Share the traffic numbers' }] }), prev)
    expect(m).toEqual({ summary: 'New summary', openQuestions: ['Does it run on-prem?'], commitments: [{ who: 'Dana', what: 'Share the traffic numbers' }] })
  })
  it('an empty list is a real answer: every question was answered', () => {
    expect(parseCallMemory(JSON.stringify({ summary: 'x', openQuestions: [], commitments: [] }), prev)).toEqual({ summary: 'x', openQuestions: [], commitments: [] })
  })
  it('a missing or wrong-shaped field keeps its previous value', () => {
    expect(parseCallMemory(JSON.stringify({ openQuestions: 'nope', commitments: { who: 'x' } }), prev)).toEqual(prev)
    expect(parseCallMemory(JSON.stringify({ summary: '', openQuestions: ['Q?'] }), prev)).toEqual({ ...prev, openQuestions: ['Q?'] })
  })
  it('not JSON, or not an object: null, so the caller keeps the previous record', () => {
    expect(parseCallMemory('Pricing came up, then SSO.', prev)).toBeNull()
    expect(parseCallMemory('[1,2]', prev)).toBeNull()
    expect(parseCallMemory(null, prev)).toBeNull()
    expect(parseCallMemory('```json\n{"summary":"fenced"}\n```', prev)?.summary).toBe('fenced')
  })
  it('caps each list and each item, drops blanks and repeats, takes a bare string as a commitment', () => {
    const many = Array.from({ length: 20 }, (_, i) => `Question ${i}?`)
    const long = 'x'.repeat(500)
    const m = parseCallMemory(JSON.stringify({ openQuestions: [long, '', 'Q?', 'q?', 3, ...many], commitments: ['Send the deck', { who: 'Dana' }, { who: ' Dana ', what: ' Share  numbers ' }, { who: 'Dana', what: 'share numbers' }] }), EMPTY_MEMORY)!
    expect(m.openQuestions).toHaveLength(LIST_MAX)
    expect(m.openQuestions[0]).toHaveLength(ITEM_MAX)
    expect(m.openQuestions[0].endsWith('…')).toBe(true)
    expect(m.openQuestions[1]).toBe('Q?')
    expect(m.openQuestions[2]).toBe('Question 0?')
    expect(m.commitments).toEqual([{ who: '', what: 'Send the deck' }, { who: 'Dana', what: 'Share numbers' }])
  })
  it('a saved record read back is checked the same way', () => {
    expect(savedCallMemory({ summary: 'S', openQuestions: ['Q?', 5], commitments: [{ who: 'A', what: 'B' }] })).toEqual({ summary: 'S', openQuestions: ['Q?'], commitments: [{ who: 'A', what: 'B' }] })
    expect(savedCallMemory([])).toBeNull()
    expect(savedCallMemory({})).toEqual(EMPTY_MEMORY)
  })
})

describe('the structured summarizer (#82)', () => {
  it('asks for JSON with the previous record, and an answered question drops off', async () => {
    let clock = 0
    const chat = vi.fn<ChatFn>()
      .mockResolvedValueOnce({ content: JSON.stringify({ summary: 'S1', openQuestions: ['Is there a free tier?'], commitments: [{ who: 'Me', what: 'Send a getting started link' }] }) })
      .mockResolvedValueOnce({ content: JSON.stringify({ summary: 'S2', openQuestions: [], commitments: [{ who: 'Me', what: 'Send a getting started link' }] }) })
    const changes: OleCallMemory[] = []
    const s = createCallSummarizer({ chat, now: () => clock, everyMs: 1000, onChange: m => changes.push(m) })
    clock = 1000
    s.push({ speaker: 'Them', text: 'Do you have a free tier?', startMs: 0 })
    await vi.waitFor(() => expect(s.memory().summary).toBe('S1'))
    const req = chat.mock.calls[0][0]
    expect(req.response_format).toEqual({ type: 'json_object' })
    expect(req.messages[0].content).toBe(SUMMARY_SYSTEM)
    expect(SUMMARY_SYSTEM).toContain('"openQuestions"')
    clock = 2000
    s.push({ speaker: 'Me', text: 'There is a community edition.', startMs: 1000 })
    await vi.waitFor(() => expect(s.memory().summary).toBe('S2'))
    const second = chat.mock.calls[1][0].messages[1].content ?? ''
    expect(second).toContain('Open questions so far:\n- Is there a free tier?')
    expect(second).toContain('Commitments so far:\n- Me: Send a getting started link')
    expect(second).not.toContain('Do you have a free tier?')
    expect(s.memory().openQuestions).toEqual([])
    expect(changes.map(c => c.summary)).toEqual(['S1', 'S2'])
    s.stop()
  })

  it('an unreadable reply keeps the previous record and folds its lines into the next update', async () => {
    let clock = 0
    const chat = vi.fn<ChatFn>()
      .mockResolvedValueOnce({ content: JSON.stringify({ summary: 'S1', openQuestions: ['Q1?'], commitments: [] }) })
      .mockResolvedValueOnce({ content: 'Sorry, here is a summary in prose.' })
      .mockResolvedValueOnce({ content: JSON.stringify({ summary: 'S3' }) })
    const onChange = vi.fn()
    const s = createCallSummarizer({ chat, now: () => clock, everyMs: 1000, onChange })
    clock = 1000; s.push({ speaker: 'Them', text: 'one', startMs: 0 })
    await vi.waitFor(() => expect(s.memory().summary).toBe('S1'))
    clock = 2000; s.push({ speaker: 'Them', text: 'two', startMs: 1000 })
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2))
    await new Promise(r => setImmediate(r))
    expect(s.memory()).toEqual({ summary: 'S1', openQuestions: ['Q1?'], commitments: [] })
    expect(onChange).toHaveBeenCalledTimes(1)
    clock = 3000; s.push({ speaker: 'Them', text: 'three', startMs: 2000 })
    await vi.waitFor(() => expect(s.memory().summary).toBe('S3'))
    expect(chat.mock.calls[2][0].messages[1].content).toContain('two')
    // fields the reply left out keep their values
    expect(s.memory().openQuestions).toEqual(['Q1?'])
    s.stop()
  })

  it('the prompts get the summary text plus the two short lists', () => {
    const text = callMemoryText(prev)
    expect(text).toBe('Pricing came up.\n\nOpen questions:\n- Is there a free tier?\n\nCommitments:\n- Me: Send the benchmark plan')
    expect(callMemoryText(EMPTY_MEMORY)).toBe('')
    expect(callMemoryText({ summary: '', openQuestions: [], commitments: [{ who: '', what: 'Follow up' }] })).toBe('Commitments:\n- Follow up')
    const user = buildBulletsPrompt({ context: null, lines: [], previous: [], summary: text })[1].content ?? ''
    expect(user).toContain('The call so far (summary):\nPricing came up.\n\nOpen questions:\n- Is there a free tier?')
  })
})

describe('open questions and commitments in the panel (#82)', () => {
  it('a compact list of each, hidden when empty', () => {
    const html = renderToStaticMarkup(createElement(OleCallLists, { openQuestions: ['Is there a free tier?'], commitments: [{ who: 'Dana', what: 'Share the numbers' }, { who: '', what: 'Book the pilot' }] }))
    expect(html).toContain('data-testid="ole-open-questions"')
    expect(html).toContain('Is there a free tier?')
    expect(html).toContain('data-testid="ole-commitments"')
    expect(html).toContain('<span class="font-semibold">Dana: </span>Share the numbers')
    expect(html).toContain('Book the pilot')
    expect(renderToStaticMarkup(createElement(OleCallLists, { openQuestions: [], commitments: [] }))).toBe('')
    const onlyQ = renderToStaticMarkup(createElement(OleCallLists, { openQuestions: ['Q?'], commitments: [] }))
    expect(onlyQ).not.toContain('ole-commitments')
  })

  const live = (lists: { openQuestions: string[]; commitments: Array<{ who: string; what: string }> }) => ({
    meetingId: 'm', preparing: false, error: null, blocked: null, unavailable: [], answers: [], prepared: null,
    bullets: [{ id: 'a', text: 'Same 429s at a fintech', source: 'call', at: 0 }], ...lists,
  })
  it('LiveView shows them under the bullets, and not at all when empty', () => {
    const html = renderToStaticMarkup(createElement(LiveView, { state: live({ openQuestions: ['Is there a free tier?'], commitments: [{ who: 'Me', what: 'Send the plan' }] }), wideOverride: true }))
    expect(html).toContain('Is there a free tier?')
    expect(html.indexOf('Same 429s at a fintech')).toBeLessThan(html.indexOf('ole-call-lists'))
    expect(html.indexOf('ole-call-lists')).toBeLessThan(html.indexOf('ole-ask'))
    expect(renderToStaticMarkup(createElement(LiveView, { state: live({ openQuestions: [], commitments: [] }), wideOverride: true }))).not.toContain('ole-call-lists')
  })

  it("the saved meeting's Ole section shows them, even with no bullets", () => {
    const html = renderToStaticMarkup(createElement(OleSavedBulletsView, { bullets: [], call: prev }))
    expect(html).toContain('data-testid="ole-saved-bullets"')
    expect(html).toContain('Is there a free tier?')
    expect(html).toContain('Send the benchmark plan')
    expect(renderToStaticMarkup(createElement(OleSavedBulletsView, { bullets: [], call: EMPTY_MEMORY }))).toBe('')
    expect(renderToStaticMarkup(createElement(OleSavedBulletsView, { bullets: [], call: null }))).toBe('')
  })
})
