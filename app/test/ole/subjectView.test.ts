// #126 in the UI: the Live tab's unmatched state, chips and "Someone else…"; Home's next meeting, its briefing's
// state and "Prepare for…". No always-visible Focus field.
import { describe, expect, it } from 'vitest'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { OleLiveState } from '../../src/main/ole/core/types'
import { OleNextCall, OlePanelHeader } from '../../src/renderer/src/ole/OlePanel'
import { OleLiveTab } from '../../src/renderer/src/ole/OleNoteTabs'

const base = (o: Partial<OleLiveState> = {}): OleLiveState => ({
  meetingId: 'm', preparing: false, error: null, blocked: null, unavailable: [], answers: [], bullets: [], openQuestions: [], commitments: [],
  prepared: { meetingTitle: 'Weekly sync', focus: null, preparedAt: 1, text: 'No matching record for this call.' }, matched: false, subjectCandidates: [], subject: null, ...o,
})
const html = (el: (p: { state: OleLiveState }) => ReactElement, state: OleLiveState) => renderToStaticMarkup(createElement(el, { state }))

describe('during a call (#126)', () => {
  it('unmatched: the message, the heard names as chips, and Someone else…', () => {
    const out = html(OleLiveTab, base({ subjectCandidates: [{ name: 'Globex', resolved: true }, { name: 'Initech', resolved: true }] }))
    expect(out).toContain("Ole hasn&#x27;t matched this call yet. It will pick up who it&#x27;s with from the conversation.")
    expect(out).toContain('Heard:')
    expect(out.match(/data-testid="ole-heard-chip"/g)).toHaveLength(2)
    expect(out).toContain('>Globex</button>')
    expect(out).toContain('·')
    expect(out).toContain('data-testid="ole-someone-else"')
    expect(out).toContain('placeholder="Someone else…"')
    // the header is Refresh briefing only: no Focus field, no Prepare button
    expect(out).toContain('Refresh briefing')
    expect(out).not.toContain('ole-focus')
    expect(out).not.toContain('Prepare for next call')
  })
  it('after a switch: one quiet line, the chosen chip pressed', () => {
    const out = html(OlePanelHeader, base({ matched: true, subject: { name: 'Globex', auto: true }, subjectCandidates: [{ name: 'Globex', resolved: true }] }))
    expect(out).toContain('Briefing updated for Globex')
    expect(out).toContain('aria-pressed="true"')
    expect(out).not.toContain('ole-unmatched')
  })
  it('matched from the calendar: no message, Someone else… one click away', () => {
    const out = html(OlePanelHeader, base({ matched: true }))
    expect(out).not.toContain('ole-unmatched')
    expect(out).not.toContain('ole-heard')
    expect(out).toContain('data-testid="ole-someone-else-link"')
    expect(out).not.toContain('data-testid="ole-someone-else"')
  })
  it('no message while preparing or when Ole is blocked', () => {
    expect(html(OlePanelHeader, base({ preparing: true }))).not.toContain('ole-unmatched')
    expect(html(OlePanelHeader, base({ blocked: 'Add an OpenAI key' }))).not.toContain('ole-unmatched')
  })
})

describe('Home before a call (#126)', () => {
  const home = (o: Partial<OleLiveState>) => base({ meetingId: null, prepared: null, matched: false, ...o })
  it('the next meeting and its briefing state', () => {
    const next = { title: 'Globex renewal', start: Date.UTC(2026, 10, 20, 15, 0) }
    expect(html(OleNextCall, home({ nextMeeting: { ...next, briefing: 'ready' } }))).toContain('Briefing ready')
    expect(html(OleNextCall, home({ nextMeeting: { ...next, briefing: 'preparing' } }))).toContain('Preparing…')
    expect(html(OleNextCall, home({ nextMeeting: { ...next, briefing: 'none' } }))).toContain('No match yet')
    expect(html(OleNextCall, home({ nextMeeting: { ...next, briefing: 'none' } }))).toContain('Next: Globex renewal')
  })
  it('Prepare for… is a link, no Focus field; the header has no Prepare button', () => {
    const out = html(OleNextCall, home({}))
    expect(out).toContain('data-testid="ole-prepare-for-link"')
    expect(out).not.toContain('data-testid="ole-prepare-for"')
    expect(html(OlePanelHeader, home({}))).not.toContain('ole-refresh')
  })
})
