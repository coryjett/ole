import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { OleBullets } from '../../src/renderer/src/ole/OleBullets'
import { OleAnswers } from '../../src/renderer/src/ole/OleAsk'
import { CallRows } from '../../src/renderer/src/ole/OleSettings'

const b = { id: 'b1', text: 'Renewal is in March', source: 'opportunity: Renewal', at: 1 }

describe('bullet controls (#54, #55)', () => {
  it('a live bullet offers pin and thumbs; pressed state shows', () => {
    const html = renderToStaticMarkup(createElement(OleBullets, { bullets: [{ ...b, pinned: true, rating: 'down' as const }], prepared: null, onPin: vi.fn(), onRate: vi.fn() }))
    expect(html).toContain('data-testid="ole-bullet-pin"')
    expect(html).toMatch(/data-testid="ole-bullet-pin"[^>]*aria-pressed="true"/)
    expect(html).toMatch(/data-testid="ole-bullet-down"[^>]*aria-pressed="true"/)
    expect(html).toMatch(/data-testid="ole-bullet-up"[^>]*aria-pressed="false"/)
  })
  it('a saved meeting shows the pin mark but no buttons', () => {
    const html = renderToStaticMarkup(createElement(OleBullets, { bullets: [{ ...b, pinned: true }], prepared: null }))
    expect(html).not.toContain('ole-bullet-pin"')
    expect(html).toContain('data-testid="ole-bullet-pinned"')
  })
})

describe('Ask answers (#53)', () => {
  it('shows each question with its answer and a linked source; a pending one says so', () => {
    const html = renderToStaticMarkup(createElement(OleAnswers, { answers: [
      { id: 'a2', question: 'who signs?', text: '', at: 2, pending: true },
      { id: 'a1', question: 'when is the renewal?', text: 'March.', source: 'opportunity: Renewal', url: 'https://crm.example/o/9', at: 1 },
    ] }))
    expect(html).toContain('who signs?')
    expect(html).toContain('Looking…')
    expect(html).toContain('March.')
    expect(html).toContain('href="https://crm.example/o/9"')
  })
})

describe('call settings (#51, #52)', () => {
  it('shows the sharing and auto-prepare controls with their values', () => {
    const html = renderToStaticMarkup(createElement(CallRows, { hideWhileSharing: true, autoPrepare: true, autoPrepareLead: 10, disabled: false, patch: vi.fn() }))
    expect(html).toContain('Hide Ole while sharing your screen')
    expect(html).toContain('Prepare before calendar meetings')
    expect(html).toMatch(/<option value="10" selected="">10 minutes before<\/option>/)
  })
})
