import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { OleSavedBulletsView } from '../../src/renderer/src/ole/OleSavedBullets'

const b = (id: string, at: number) => ({ id, text: `text ${id}`, source: `source ${id}`, at })

describe("a saved meeting's context bullets", () => {
  it('shows them newest first with their sources and a count', () => {
    const html = renderToStaticMarkup(createElement(OleSavedBulletsView, { bullets: [b('a', 1), b('b', 2)] }))
    expect(html).toContain('Context from the call (2)')
    expect(html.indexOf('text b')).toBeLessThan(html.indexOf('text a'))
    expect(html).toContain('source a')
  })
  it('shows nothing for a meeting without bullets', () => {
    expect(renderToStaticMarkup(createElement(OleSavedBulletsView, { bullets: [] }))).toBe('')
  })
})
