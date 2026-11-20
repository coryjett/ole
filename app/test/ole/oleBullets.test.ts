import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import type { OleBullet } from '../../src/main/ole/types'
import { OleBullets } from '../../src/renderer/src/ole/OleBullets'

const bullet = (id: string, text: string, source: string, at: number): OleBullet => ({ id, text, source, at })

describe('OleBullets', () => {
  it('renders prepared header with meeting and account', () => {
    const html = renderToStaticMarkup(
      createElement(OleBullets, { bullets: [], prepared: { meetingTitle: 'Kickoff', accountName: 'Acme' } })
    )
    expect(html).toContain('Prepared for: Kickoff, Acme')
  })

  it('renders No account header with meeting title', () => {
    const html = renderToStaticMarkup(
      createElement(OleBullets, { bullets: [], prepared: { meetingTitle: 'Kickoff', accountName: null } })
    )
    expect(html).toContain('No account: Kickoff')
  })

  it('renders No account header without meeting title', () => {
    const html = renderToStaticMarkup(
      createElement(OleBullets, { bullets: [], prepared: { meetingTitle: null, accountName: null } })
    )
    expect(html).toContain('>No account</p>')
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
