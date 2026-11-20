import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createBulletsEngine, overlap, parseBullets, type ChatFn } from '../../src/main/ole/bullets'
import { OleBullets } from '../../src/renderer/src/ole/OleBullets'
import type { OleBullet } from '../../src/main/ole/types'

const context = { meetingTitle: 'Sync', focus: null, preparedAt: 0, text: '## Issues\n- Issue #412: 429 errors returned under burst traffic (issue #412)' }

describe('a short excerpt under each bullet (#39)', () => {
  it('parses heard and quote, trimmed', () => {
    const [b] = parseBullets(JSON.stringify({ bullets: [{ text: 't', source: 'issue #412', heard: '"we keep hitting rate limits"', quote: 'x'.repeat(300) }] }))
    expect(b.heard).toBe('we keep hitting rate limits')
    expect(b.quote!.length).toBeLessThanOrEqual(160)
  })
  it('loose match: most words must be present', () => {
    expect(overlap('429 errors returned under burst', context.text)).toBe(1)
    expect(overlap('customer churned last quarter', context.text)).toBe(0)
  })
  it('keeps excerpts Ole can find, drops an invented quote', async () => {
    let now = 0
    const reply = { bullets: [
      { text: 'Matches open issue #412', source: 'issue #412', heard: 'keep hitting rate limits', quote: '429 errors returned under burst traffic' },
      { text: 'A fintech fixed it in 2.3', source: 'call brief', heard: 'keep hitting rate limits', quote: 'fixed by raising the burst budget' },
    ] }
    const chat = vi.fn<ChatFn>(async () => ({ content: JSON.stringify(reply) }))
    let got: OleBullet[] = []
    const engine = createBulletsEngine({ chat, tools: () => [], callTool: vi.fn(), context: () => context, onBullets: b => { got = b }, now: () => now, minIntervalMs: 1000 })
    engine.push({ speaker: 'Them', text: 'we keep hitting rate limits when traffic spikes', startMs: 0 })
    await vi.waitFor(() => expect(got.length).toBe(2))
    const issue = got.find(b => b.source === 'issue #412')!, fintech = got.find(b => b.source === 'call brief')!
    expect(issue.quote).toBe('429 errors returned under burst traffic')
    expect(issue.heard).toBe('keep hitting rate limits')
    expect(fintech.quote).toBeUndefined()
    engine.stop()
  })
  it('shows Heard and the quote with its source', () => {
    const html = renderToStaticMarkup(createElement(OleBullets, { bullets: [{ id: 'a', text: 'Matches issue', source: 'issue #412', at: 0, heard: 'rate limits', quote: '429 errors' }], prepared: null, now: 100_000 }))
    expect(html).toContain('Heard: “rate limits”')
    expect(html).toContain('From issue #412: “429 errors”')
  })
})

describe('headline bullets (#40)', () => {
  it('the prompt asks for headlines of 10 words at most', async () => {
    const { BULLETS_SYSTEM } = await import('../../src/main/ole/bullets')
    expect(BULLETS_SYSTEM).toContain('10 words at most')
  })
  it('cuts a wordy bullet at a word boundary', () => {
    const long = 'Ambient uses one lightweight Rust ztunnel per node for mTLS; assess fit against the multi-cluster and phased-policy priorities'
    const [b] = parseBullets(JSON.stringify({ bullets: [{ text: long, source: 'docs' }] }))
    expect(b.text.length).toBeLessThanOrEqual(90)
    expect(b.text.endsWith('…')).toBe(true)
    expect(b.text).not.toMatch(/\s…$/)
  })
})
