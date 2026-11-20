import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { briefingHeadings, onlyHeadings, BULLETS_SYSTEM } from '../../src/main/ole/bullets'
import { OleBriefing } from '../../src/renderer/src/ole/OleBriefing'

const brief = '## Who and why\n- Wants one place for policy (call brief, 12 Nov)\n## Deals\n- K Agent at Meeting Booked (opportunity: K Agent)\nWatch for:\n- risk'

describe('real sources only (#37)', () => {
  const h = briefingHeadings(brief)
  it('reads the briefing headings', () => {
    expect([...h].sort()).toEqual(['deals', 'watch for', 'who and why'])
  })
  it('drops headings, "transcript", "prepared context" and bare tool names', () => {
    for (const s of ['Who and why', 'Deals; Who and why', 'Transcript', 'Transcript [0:35–1:02]', 'Prepared context — Deals', 'Prepared context', '[get_account_health]', '']) // a tool with a record is a real source since #48
      expect(onlyHeadings(s, h), s).toBe(true)
  })
  it('keeps records a person can look up', () => {
    for (const s of ['opportunity: K Agent', 'call brief, 12 Nov', 'issue #412', 'product docs', 'Deals; opportunity: K Agent'])
      expect(onlyHeadings(s, h), s).toBe(false)
  })
  it('the prompt forbids restating the call and heading sources', () => {
    expect(BULLETS_SYSTEM).toContain('Never restate')
    expect(BULLETS_SYSTEM).toContain('is never a source')
  })
})

describe('the briefing is readable (#35)', () => {
  it('renders headings and bullets, open when asked', () => {
    const html = renderToStaticMarkup(createElement(OleBriefing, { text: brief, defaultOpen: true }))
    expect(html).toContain('Who and why')
    expect(html).toContain('Wants one place for policy (call brief, 12 Nov)')
    expect(html).toContain('Copy')
  })
  it('stays folded when not, and shows nothing for no briefing', () => {
    expect(renderToStaticMarkup(createElement(OleBriefing, { text: brief, defaultOpen: false }))).not.toContain('Wants one place')
    expect(renderToStaticMarkup(createElement(OleBriefing, { text: ' ', defaultOpen: true }))).toBe('')
  })
})

describe('tool-plus-record citations are real sources (#48)', () => {
  it('keeps "[get_account_details: Bridgewater Associates]" and drops only a bare tool name', async () => {
    const { onlyHeadings, readableSource } = await import('../../src/main/ole/bullets')
    const none = new Set<string>()
    expect(onlyHeadings('[get_account_details: Bridgewater Associates]', none)).toBe(false)
    expect(onlyHeadings('get_account_health: Bridgewater; get_interactions: POC check in, 19 Nov', none)).toBe(false)
    expect(onlyHeadings('get_account_health', none)).toBe(true)
    expect(onlyHeadings('[get_account_health:]', none)).toBe(true)
    expect(readableSource('[get_account_details: Bridgewater Associates]')).toBe('account details: Bridgewater Associates')
  })
})
