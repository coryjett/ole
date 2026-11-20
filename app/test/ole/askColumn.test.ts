// Ask as a chat column on the right of a wide call note (#148): the breakpoint, the remembered collapse, the column's
// order, sources and pending answer, and the Live tab leaving its answers to the column.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { OleAskColumn } from '../../src/renderer/src/ole/OleAsk'
import { OleLiveTab } from '../../src/renderer/src/ole/OleNoteTabs'
import {
  ASK_COLUMN_BREAKPOINT, ASK_COLUMN_KEY, ASK_COLUMN_WIDTH, askColumnFits, askColumnShown, readAskColumnCollapsed, writeAskColumnCollapsed,
} from '../../src/renderer/src/ole/oleAskColumn'
import type { OleLiveState } from '../../src/shared/types'

afterEach(() => { vi.unstubAllGlobals() })

const live = (o: Partial<OleLiveState> = {}): OleLiveState => ({
  meetingId: 'm1', preparing: false, error: null, blocked: null, unavailable: [], bullets: [], openQuestions: [], commitments: [], prepared: null, answers: [], ...o,
})
// newest first, as the session keeps them
const three = [
  { id: 'a3', question: 'Third?', text: 'Three.', at: 3, source: 'Renewal', url: 'https://crm.example/opp/3' },
  { id: 'a2', question: 'Second?', text: 'Two.', at: 2 },
  { id: 'a1', question: 'First?', text: 'One.', at: 1, source: 'Bad', url: 'javascript:alert(1)' },
]
const memory = (init: Record<string, string> = {}) => {
  const data = new Map(Object.entries(init))
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) }, data }
}
const column = (state: OleLiveState) => renderToStaticMarkup(createElement(OleAskColumn, { state, meetingId: 'm1' }))

describe('the breakpoint (#148)', () => {
  it('a note view 1000 px and wider gets the column; narrower, or not measured, keeps the dock', () => {
    expect(ASK_COLUMN_BREAKPOINT).toBe(1000)
    expect(ASK_COLUMN_WIDTH).toBe(320)
    expect(askColumnFits(1000)).toBe(true)
    expect(askColumnFits(1440)).toBe(true)
    expect(askColumnFits(999.5)).toBe(false)
    expect(askColumnFits(0)).toBe(false)
    expect(askColumnFits(Number.NaN)).toBe(false)
    expect(askColumnFits(Number.POSITIVE_INFINITY)).toBe(false)
  })
  it("shown only on a wide note during its own call while live context can answer", () => {
    const base = { wide: true, recording: true, meetingId: 'm1', state: live() }
    expect(askColumnShown(base)).toBe(true)
    expect(askColumnShown({ ...base, wide: false })).toBe(false)
    expect(askColumnShown({ ...base, recording: false })).toBe(false)
    expect(askColumnShown({ ...base, state: null })).toBe(false)
    expect(askColumnShown({ ...base, state: live({ meetingId: 'm2' }) })).toBe(false)
    expect(askColumnShown({ ...base, state: live({ blocked: 'Add an OpenAI key' }) })).toBe(false)
  })
})

describe('the remembered collapse (#148)', () => {
  it('open by default, collapsed once saved, and back', () => {
    const s = memory()
    expect(readAskColumnCollapsed(s)).toBe(false)
    writeAskColumnCollapsed(true, s)
    expect(s.data.get(ASK_COLUMN_KEY)).toBe('1')
    expect(readAskColumnCollapsed(s)).toBe(true)
    writeAskColumnCollapsed(false, s)
    expect(readAskColumnCollapsed(s)).toBe(false)
  })
  it('a storage that throws, or none, falls back to open and never throws on write', () => {
    const broken = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('full') } }
    expect(readAskColumnCollapsed(broken)).toBe(false)
    expect(() => writeAskColumnCollapsed(true, broken)).not.toThrow()
    expect(readAskColumnCollapsed(undefined)).toBe(false)
    vi.stubGlobal('localStorage', undefined)
    expect(readAskColumnCollapsed()).toBe(false)
  })
})

describe('the column (#148)', () => {
  it('every answer, oldest at the top and newest at the bottom next to the box, each with its source (https links only)', () => {
    vi.stubGlobal('localStorage', memory())
    const html = column(live({ answers: three }))
    expect(html).toContain('data-testid="ole-ask-column"')
    expect(html).toContain('width:320px')
    expect(html).toContain('Answers from this call and your servers')
    expect(html.indexOf('One.')).toBeLessThan(html.indexOf('Two.'))
    expect(html.indexOf('Two.')).toBeLessThan(html.indexOf('Three.'))
    expect(html.indexOf('Three.')).toBeLessThan(html.indexOf('ole-ask-input'))
    expect(html).toContain('href="https://crm.example/opp/3"')
    expect(html).toContain('Bad')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('earlier')
    expect(html).toContain('data-testid="ole-ask-collapse"')
  })
  it('a pending answer says it is looking', () => {
    vi.stubGlobal('localStorage', memory())
    expect(column(live({ answers: [{ id: 'p', question: 'Q?', text: '', at: 4, pending: true }, ...three] }))).toMatch(/Three\.[\s\S]*Looking…/)
  })
  it('collapsed (remembered): a slim Ask strip with the count of answers, no box', () => {
    vi.stubGlobal('localStorage', memory({ [ASK_COLUMN_KEY]: '1' }))
    const html = column(live({ answers: three }))
    expect(html).toContain('data-testid="ole-ask-strip"')
    expect(html).toContain('data-testid="ole-ask-expand"')
    expect(html).toContain('aria-label="Open Ask, 3 answers"')
    expect(html).toMatch(/data-testid="ole-ask-strip-count"[^>]*>3</)
    expect(html).not.toContain('ole-ask-input')
    expect(html).not.toContain('ole-ask-column"')
  })
  it('a storage that throws shows the column open', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } })
    expect(column(live({ answers: three }))).toContain('data-testid="ole-ask-column"')
  })
  it("another meeting's call, or blocked live context: nothing", () => {
    vi.stubGlobal('localStorage', memory())
    expect(column(live({ meetingId: 'm2' }))).toBe('')
    expect(column(live({ blocked: 'Add an OpenAI key' }))).toBe('')
  })
})

describe('the Live tab beside the column (#148)', () => {
  it('leaves its answers to the column when it is shown, and keeps them when it is not', () => {
    const hidden = renderToStaticMarkup(createElement(OleLiveTab, { state: live({ answers: three }), answersInColumn: true }))
    expect(hidden).not.toContain('ole-answers')
    expect(hidden).not.toContain('Three.')
    const kept = renderToStaticMarkup(createElement(OleLiveTab, { state: live({ answers: three }) }))
    expect(kept).toContain('data-testid="ole-answers"')
    for (const t of ['One.', 'Two.', 'Three.']) expect(kept).toContain(t)
  })
})
