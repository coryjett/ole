import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OleCallSourcesView } from '../../src/renderer/src/ole/OleSavedBullets'

const bullet = { id: 'b1', text: 'Renewal is in March', source: 'opportunity: Renewal', url: 'https://example.com/opp', at: 1 }
const answer = { id: 'a1', question: 'what shipped in 2.3?', text: 'Burst limits.', at: 2 }

describe('sources from the call, under the summary (#170)', () => {
  it('a collapsed section with the bullets and their links, the answers, and Export for replay', () => {
    const html = renderToStaticMarkup(createElement(OleCallSourcesView, { meetingId: 'm', bullets: [bullet as never], answers: [answer as never], exportable: true }))
    expect(html).toContain('<details')
    expect(html).not.toContain('<details open')
    expect(html).toContain('Sources from the call (2)')
    expect(html).toContain('Renewal is in March')
    expect(html).toContain('https://example.com/opp')
    expect(html).toContain('what shipped in 2.3?')
    expect(html).toContain('data-testid="ole-export-replay"')
  })
  it('no open questions or commitments here: the summary has them', () => {
    const html = renderToStaticMarkup(createElement(OleCallSourcesView, { meetingId: 'm', bullets: [bullet as never], answers: [], exportable: true }))
    expect(html).not.toContain('ole-call-lists')
  })
  it('nothing kept and nothing to export: nothing shown', () => {
    expect(renderToStaticMarkup(createElement(OleCallSourcesView, { meetingId: 'm', bullets: [], answers: [], exportable: false }))).toBe('')
  })
  it('only an export: the section still shows, so the call can be exported', () => {
    const html = renderToStaticMarkup(createElement(OleCallSourcesView, { meetingId: 'm', bullets: [], answers: [], exportable: true }))
    expect(html).toContain('From the call')
    expect(html).toContain('data-testid="ole-export-replay"')
  })
})
