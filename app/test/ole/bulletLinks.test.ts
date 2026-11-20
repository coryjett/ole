import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createBulletsEngine, parseBullets, type ChatFn } from '../../src/main/ole/bullets'
import { OleBullets } from '../../src/renderer/src/ole/OleBullets'
import { BriefingText } from '../../src/renderer/src/ole/OleBriefing'
import type { OleBullet } from '../../src/main/ole/types'

const real = 'https://github.com/example/project/issues/412'
const context = { meetingTitle: 'Sync', focus: null, preparedAt: 0, text: `- 429 errors under burst traffic ([issue #412](${real}))` }

describe('links to sources (#42)', () => {
  it('parses https links only', () => {
    expect(parseBullets(JSON.stringify({ bullets: [{ text: 't', source: 's', url: real }] }))[0].url).toBe(real)
    expect(parseBullets(JSON.stringify({ bullets: [{ text: 't', source: 's', url: 'http://x.example/a' }] }))[0].url).toBeUndefined()
    expect(parseBullets(JSON.stringify({ bullets: [{ text: 't', source: 's', url: 'javascript:alert(1)' }] }))[0].url).toBeUndefined()
  })
  it('keeps a link Ole has, drops one the model made up', async () => {
    const chat = vi.fn<ChatFn>(async () => ({ content: JSON.stringify({ bullets: [
      { text: 'Matches issue #412', source: 'issue #412', url: real },
      { text: 'Docs cover burst limits', source: 'product docs', url: 'https://docs.example.com/made-up-page' },
    ] }) }))
    let got: OleBullet[] = []
    const engine = createBulletsEngine({ chat, tools: () => [], callTool: vi.fn(), context: () => context, onBullets: b => { got = b }, now: () => 0, minIntervalMs: 1000 })
    engine.push({ speaker: 'Them', text: 'rate limits again', startMs: 0 })
    await vi.waitFor(() => expect(got.length).toBe(2))
    expect(got.find(b => b.source === 'issue #412')!.url).toBe(real)
    expect(got.find(b => b.source === 'product docs')!.url).toBeUndefined()
    engine.stop()
  })
  it('renders the source as a link that opens in the browser', () => {
    const html = renderToStaticMarkup(createElement(OleBullets, { bullets: [{ id: 'a', text: 'Matches', source: 'issue #412', url: real, at: 0 }], prepared: null, now: 100_000 }))
    expect(html).toContain(`href="${real}"`)
    expect(html).toContain('target="_blank"')
  })
  it('briefing markdown links render as links; non-https stays text', () => {
    const html = renderToStaticMarkup(createElement(BriefingText, { text: `See [issue #412](${real}) and [x](http://bad.example)` }))
    expect(html).toContain(`href="${real}"`)
    expect(html).not.toContain('href="http://bad.example"')
  })
})
