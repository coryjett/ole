import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { OleAskPanel } from '../../src/renderer/src/ole/OleAsk'

const state = { meetingId: 'live-meeting', preparing: false, error: null, blocked: null, unavailable: [], bullets: [], prepared: null,
  answers: [{ id: 'a1', question: 'q?', text: 'Live call answer', at: 1 }] }

describe('the docked Ask belongs to its own call (#125)', () => {
  it("renders nothing on another meeting's note", () => {
    expect(renderToStaticMarkup(createElement(OleAskPanel, { state: state as never, docked: true, meetingId: 'other-meeting' }))).toBe('')
  })
  it("renders on the live call's note", () => {
    expect(renderToStaticMarkup(createElement(OleAskPanel, { state: state as never, docked: true, meetingId: 'live-meeting' }))).toContain('Live call answer')
  })
})
