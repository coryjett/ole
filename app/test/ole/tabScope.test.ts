import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { OleTabPanels } from '../../src/renderer/src/ole/OleNoteTabs'

const otherCall = { meetingId: '00000000-0000-4000-8000-0000000000aa', preparing: false, error: null, blocked: null, unavailable: [], answers: [],
  bullets: [{ id: 'b1', text: 'Another call bullet', source: 'docs', at: 1 }],
  prepared: { meetingTitle: 'Other', focus: null, preparedAt: 1, text: 'Other call briefing' } }

describe("live tabs only show the call their note belongs to (#113)", () => {
  it("a different meeting's note never shows the current call's bullets or briefing", () => {
    const ole = { state: otherCall as never, saved: null, tabs: ['live', 'briefing'] as never, unseen: 0 }
    const html = renderToStaticMarkup(createElement(OleTabPanels, { tab: 'live', meetingId: '00000000-0000-4000-8000-0000000000bb', recording: true, ole }))
    expect(html).not.toContain('Another call bullet')
    expect(html).not.toContain('Other call briefing')
  })
})
