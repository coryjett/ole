// Settings > Calendars says when meetings come from a meetings server (#149)
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import { OleCalendarNote } from '../../src/renderer/src/ole/OleCalendarNote'

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); vi.doUnmock('react') })

it('names the server and says it may list only some meetings', () => {
  const html = renderToStaticMarkup(createElement(OleCalendarNote, { server: 'Meetings' }))
  expect(html).toContain('data-testid="ole-calendar-server"')
  expect(html).toContain('Meetings from Meetings. It may list only some of your meetings.')
  expect(renderToStaticMarkup(createElement(OleCalendarNote, { server: null }))).toBe('')
  expect(renderToStaticMarkup(createElement(OleCalendarNote, {}))).toBe('')
})

it('the Calendars section shows the note only when the list names a server', async () => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) })
  const react = await vi.importActual<typeof import('react')>('react')
  for (const server of ['Team calendar', undefined]) {
    vi.doMock('react', () => ({ ...react, useState: (init: unknown) => react.useState(init === undefined ? { status: 'denied', calendars: [], hideEventsWithoutCallLink: false, ...(server ? { server } : {}) } : init) }))
    const { CalendarSettings } = await import('../../src/renderer/src/components/CalendarSettings')
    const { renderToStaticMarkup: render } = await import('react-dom/server')
    const html = render((await import('react')).createElement(CalendarSettings))
    if (server) expect(html).toContain('Meetings from Team calendar. It may list only some of your meetings.')
    else expect(html).not.toContain('ole-calendar-server')
    vi.resetModules(); vi.doUnmock('react')
  }
})
