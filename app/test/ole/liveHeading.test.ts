import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { OlePanelHeader } from '../../src/renderer/src/ole/OlePanel'

const state = { meetingId: 'm', preparing: false, error: null, blocked: null, unavailable: [], bullets: [], answers: [], prepared: null }

it('the panel has no "Ole" heading: the app and the tab already say where you are', () => {
  expect(renderToStaticMarkup(createElement(OlePanelHeader, { state: state as never }))).not.toContain('>Ole<')
})
