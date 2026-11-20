import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { OlePanelHeader } from '../../src/renderer/src/ole/OlePanel'

const state = { meetingId: 'm', preparing: false, error: null, blocked: null, unavailable: [], bullets: [], answers: [], prepared: null }

it('the panel has no "Ole" heading: the app and the tab already say where you are', () => {
  expect(renderToStaticMarkup(createElement(OlePanelHeader, { state: state as never }))).not.toContain('>Ole<')
})

it('the Live tab drops the vague "Prepared for" line above the bullets (#140)', async () => {
  const { OleBullets } = await import('../../src/renderer/src/ole/OleBullets')
  const prepared = { meetingTitle: null, focus: null }
  expect(renderToStaticMarkup(createElement(OleBullets, { bullets: [], prepared, header: false }))).not.toContain('Prepared for')
  expect(renderToStaticMarkup(createElement(OleBullets, { bullets: [], prepared }))).toContain('Prepared for')
})
