import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeYouJoin } from '../../src/renderer/src/ole/OleBriefing'
import { LiveView } from '../../src/renderer/src/ole/OlePanel'

const text = '## Before you join\n- Kickoff moves POC to production\n- Bedrock fix still owed\n- They want one place for policy\n- extra\n## Who\n- Artem, architect'
const state = (bullets = [{ id: 'a', text: 'Same 429s at a fintech', source: 'call', at: 0 }]) => ({
  meetingId: 'm', preparing: false, error: null, blocked: null, unavailable: [], answers: [], bullets,
  prepared: { meetingTitle: 'Kickoff', focus: null, preparedAt: 1, text },
})

describe('briefing and bullets together (#49)', () => {
  it('reads the three "Before you join" items', () => {
    expect(beforeYouJoin(text)).toEqual(['Kickoff moves POC to production', 'Bedrock fix still owed', 'They want one place for policy'])
    expect(beforeYouJoin('## Who\n- x')).toEqual([])
  })
  it('wide: bullets with the pinned strip, and the briefing beside them', () => {
    const html = renderToStaticMarkup(createElement(LiveView, { state: state(), wideOverride: true }))
    expect(html).toContain('data-testid="ole-live-split"')
    expect(html).toContain('data-testid="ole-before-strip"')
    expect(html).toContain('Same 429s at a fintech')
    expect(html).toContain('Artem, architect')
  })
  it('narrow: tabs, with the Live count', () => {
    const html = renderToStaticMarkup(createElement(LiveView, { state: state(), wideOverride: false }))
    expect(html).toContain('data-testid="ole-live-tabs"')
    expect(html).toContain('Live (1)')
    expect(html).toContain('Briefing')
  })
})
