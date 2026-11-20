import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { OleSubject } from '../../src/renderer/src/ole/OlePanel'

const base = { meetingId: 'm', preparing: false, error: null, blocked: null, unavailable: [], bullets: [], answers: [], prepared: null }

describe('who the briefing is for (#138)', () => {
  it('a matched call names it, with a way to switch', () => {
    const html = renderToStaticMarkup(createElement(OleSubject, { state: { ...base, matched: true, matchedName: 'Example Cruise Co' } as never }))
    expect(html).toContain('Briefing for Example Cruise Co')
    expect(html).toContain('data-testid="ole-not-right"')
    expect(html).not.toContain('ole-someone-else-link')
  })
  it('an unmatched call keeps the unmatched message and no name', () => {
    const html = renderToStaticMarkup(createElement(OleSubject, { state: { ...base, matched: false, matchedName: null } as never }))
    expect(html).not.toContain('Briefing for')
    expect(html).toContain('hasn')
  })
})
