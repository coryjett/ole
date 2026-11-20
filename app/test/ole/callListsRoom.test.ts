import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { EMPTY_MEMORY } from '../../src/main/ole/core/callSummary'
import { OleCallLists } from '../../src/renderer/src/ole/OleCallLists'
import { OleSavedBulletsView } from '../../src/renderer/src/ole/OleSavedBullets'

const lists = { openQuestions: ['Is there a free tier?', 'Who signs?'], commitments: [{ who: 'Dana', what: 'Share the numbers' }, { who: '', what: 'Book the pilot' }, { who: 'Me', what: 'Send the doc', done: true }] }

describe('room for the call lists (#166)', () => {
  it('each list is its own card, with readable text and space between items', () => {
    const html = renderToStaticMarkup(createElement(OleCallLists, lists))
    expect(html.match(/class="ole-call-card"/g)).toHaveLength(2)
    expect(html).toContain('text-[13px] leading-[20px]')
    expect(html).not.toContain('text-[12px]')
    expect(html).toContain('gap-1.5')
  })
  it('a marker per item, and the person as a label', () => {
    const html = renderToStaticMarkup(createElement(OleCallLists, lists))
    expect(html.match(/<span class="ole-mark" aria-hidden="true">\?<\/span>/g)).toHaveLength(2)
    expect(html.match(/<span class="ole-mark" aria-hidden="true">○<\/span>/g)).toHaveLength(2)
    expect(html).toContain('<span class="ole-who">Dana</span>')
    expect(html).not.toContain('Dana: ')
  })
  it('the saved meeting counts everything it shows, not only bullets', () => {
    const html = renderToStaticMarkup(createElement(OleSavedBulletsView, { bullets: [], call: { ...EMPTY_MEMORY, ...lists } }))
    expect(html).toContain('Context from the call (5)')
  })
})
