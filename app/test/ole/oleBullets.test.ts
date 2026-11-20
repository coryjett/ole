import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import type { OleBullet } from '../../src/main/ole/types'
import { OleBullets } from '../../src/renderer/src/ole/OleBullets'

const bullet = (id: string, text: string, source: string, at: number): OleBullet => ({ id, text, source, at })

describe('OleBullets', () => {
  it('renders the prepared header with meeting and focus', () => {
    const html = renderToStaticMarkup(createElement(OleBullets, { bullets: [], prepared: { meetingTitle: 'Kickoff', focus: 'Acme' } }))
    expect(html).toContain('Prepared for: Kickoff · Acme')
  })

  it('renders the meeting alone when there is no focus', () => {
    const html = renderToStaticMarkup(createElement(OleBullets, { bullets: [], prepared: { meetingTitle: 'Kickoff', focus: null } }))
    expect(html).toContain('Prepared for: Kickoff<')
  })

  it('says when nothing is prepared yet', () => {
    const html = renderToStaticMarkup(createElement(OleBullets, { bullets: [], prepared: null }))
    expect(html).toContain('>Not prepared yet</p>')
  })

  it('renders empty state when no bullets', () => {
    const html = renderToStaticMarkup(createElement(OleBullets, { bullets: [], prepared: null }))
    expect(html).toContain('Context will appear here as the call goes.')
  })

  it('renders bullets newest first and shows source', () => {
    const html = renderToStaticMarkup(
      createElement(OleBullets, {
        bullets: [bullet('1', 'older', 'src-a', 10), bullet('2', 'newer', 'src-b', 20)],
        prepared: null,
      })
    )
    expect(html).toContain('newer')
    expect(html).toContain('src-b')
    expect(html).toContain('src-a')
    expect(html).toContain('data-testid="ole-bullet-source"')
    expect(html.indexOf('newer')).toBeLessThan(html.indexOf('older'))
  })
})

describe('short, scrolling list (#38)', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ id: `b${i}`, text: `t${i}`, source: `s${i}`, at: 1000 + i }))
  it('opens the newest 4, folds the rest, and scrolls', () => {
    const html = renderToStaticMarkup(createElement(OleBullets, { bullets: many, prepared: null, now: 1_000_000 }))
    expect((html.match(/data-testid="ole-bullet"/g) ?? []).length).toBe(4)
    expect(html).toContain('Show 5 earlier')
    expect(html).toContain('overflow-y:auto')
    expect(html.indexOf('t8')).toBeLessThan(html.indexOf('t5'))
  })
  it('highlights a bullet that just arrived', () => {
    const html = renderToStaticMarkup(createElement(OleBullets, { bullets: [{ id: 'n', text: 'new', source: 'x', at: 10_000 }], prepared: null, now: 12_000 }))
    expect(html).toContain('data-new="true"')
  })
})
