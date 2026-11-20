import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { cleanLabel, httpsHref, keepLink, LABEL_MAX, linkAndLabel, receivedUrls, shownSource, sourceLabel } from '../../src/main/ole/core/links'
import { OleAnswers } from '../../src/renderer/src/ole/OleAsk'
import { OleSavedBulletsView } from '../../src/renderer/src/ole/OleSavedBullets'
import { createBulletsEngine, type ChatFn } from '../../src/main/ole/core/bullets'
import { answerQuestion } from '../../src/main/ole/core/ask'
import { parseFacts } from '../../src/main/ole/core/enrich'
import { SourceName } from '../../src/renderer/src/ole/OleBullets'
import type { OleBullet } from '../../src/main/ole/core/types'

const page = 'https://docs.example.com/guides/rate-limits'
const other = 'https://docs.example.com/guides/jwt'

describe('received addresses (#107)', () => {
  it('splits on whitespace, quotes, angle brackets and parentheses, and drops trailing punctuation', () => {
    const got = receivedUrls(`see ${page}. also "${other}" and <https://a.example/x>, ([doc](https://b.example/y)); done: https://c.example/z;`)
    expect([...got].sort()).toEqual(['https://a.example/x', 'https://b.example/y', 'https://c.example/z', other, page].sort())
  })
  it('only https addresses are collected', () => {
    expect([...receivedUrls('http://plain.example/a ftp://f.example/b https://s.example/c')]).toEqual(['https://s.example/c'])
  })
})

describe('keepLink (#107)', () => {
  const received = receivedUrls(`results: ${page}/more and ${other}`)
  it('needs the exact address, not a prefix or an extension of one received', () => {
    expect(keepLink(other, received)).toBe(true)
    expect(keepLink(page, received)).toBe(false) // only page/more was received
    expect(keepLink(`${other}/extra`, received)).toBe(false)
    expect(keepLink('https://docs.example.com/guides', received)).toBe(false)
  })
  it('rejects an address carrying a username or password, even when received', () => {
    const tricky = 'https://good.example@evil.example/x'
    const withPass = 'https://user:pw@evil.example/x'
    const r = receivedUrls(`${tricky} ${withPass}`)
    expect(r.has(tricky)).toBe(true)
    expect(keepLink(tricky, r)).toBe(false)
    expect(keepLink(withPass, r)).toBe(false)
  })
  it('rejects http, and allows an upper-case https scheme', () => {
    expect(keepLink('http://docs.example.com/a', new Set(['http://docs.example.com/a']))).toBe(false)
    expect(keepLink('HTTPS://docs.example.com/a', receivedUrls('HTTPS://docs.example.com/a'))).toBe(true)
  })
  it('rejects an address over 500 characters', () => {
    const long = `https://docs.example.com/${'a'.repeat(500)}`
    expect(keepLink(long, receivedUrls(long))).toBe(false)
  })
})

describe('labels from the link actually used (#107)', () => {
  const received = receivedUrls(`${page} ${other}`)
  it('a source that is an address is labeled from the given link when both are received', () => {
    expect(linkAndLabel(other, page, received)).toEqual({ source: sourceLabel(other), url: other })
    expect(sourceLabel(other)).toBe('docs.example.com › jwt')
  })
  it('a text source is kept as written', () => {
    expect(linkAndLabel(other, 'product docs', received)).toEqual({ source: 'product docs', url: other })
  })
  it('a given link Ole never received falls back to the address source', () => {
    expect(linkAndLabel('https://made.up/1', page, received)).toEqual({ source: 'docs.example.com › rate limits', url: page })
  })
  it('bullets use the label of the link they carry', async () => {
    const chat = vi.fn<ChatFn>(async () => ({ content: JSON.stringify({ bullets: [{ text: 'JWT is covered', source: page, url: other }] }) }))
    let got: OleBullet[] = []
    const context = { meetingTitle: 'Sync', focus: null, preparedAt: 0, text: `docs: ${page} and ${other}` }
    const engine = createBulletsEngine({ chat, tools: () => [], callTool: vi.fn(), context: () => context, onBullets: b => { got = b }, now: () => 0, minIntervalMs: 1000 })
    engine.push({ speaker: 'Them', text: 'how do tokens work', startMs: 0 })
    await vi.waitFor(() => expect(got.length).toBe(1))
    expect(got[0]).toMatchObject({ source: 'docs.example.com › jwt', url: other })
    engine.stop()
  })
  it('Ask keeps only an exact received link, and labels from it', async () => {
    const ctx = { meetingTitle: 'Acme', focus: null, text: `see ${page}/more and ${other}`, preparedAt: 1 }
    const chat = vi.fn<ChatFn>().mockResolvedValue({ content: JSON.stringify({ answer: 'Limits are per key.', source: page, url: page }) })
    const a = await answerQuestion({ chat, question: 'limits?', context: ctx, lines: [], tools: [], call: vi.fn() })
    expect(a.url).toBeUndefined() // a prefix of a received address
    expect(a.source).toBe('docs.example.com › rate limits')
    chat.mockResolvedValueOnce({ content: JSON.stringify({ answer: 'JWT.', source: page, url: other }) })
    expect(await answerQuestion({ chat, question: 'jwt?', context: ctx, lines: [], tools: [], call: vi.fn() })).toMatchObject({ source: 'docs.example.com › jwt', url: other })
  })
  it('enrichment facts keep only an exact received link without credentials', () => {
    const material = `customer since 2024 https://crm.example.com/a/42 https://u@crm.example.com/a/7`
    const facts = parseFacts(JSON.stringify({ facts: [
      { text: 'A', source: 'account: N', quote: 'customer since 2024', url: 'https://crm.example.com/a/4' },
      { text: 'B', source: 'account: N', quote: 'customer since 2024', url: 'https://crm.example.com/a/42' },
      { text: 'C', source: 'account: N', quote: 'customer since 2024', url: 'https://u@crm.example.com/a/7' },
    ] }), material)
    expect(facts.map(f => f.url)).toEqual([undefined, 'https://crm.example.com/a/42', undefined])
  })
})

describe('no hidden characters in labels (#107)', () => {
  const sneaky = 'https://docs.example.com/guides/%E2%80%AEfdp.exe%E2%80%8B%E2%81%A6x'
  it('core strips bidi overrides, isolates and zero-width characters', () => {
    const label = sourceLabel(sneaky)
    expect(label).toBe('docs.example.com › fdp.exex')
    expect(label).not.toMatch(/[‪-‮⁦-⁩​-‏]/)
    expect(cleanLabel('a‮b\u0007c﻿d')).toBe('abcd')
  })
  it('core caps the label length', () => {
    const label = sourceLabel(`https://docs.example.com/${'word-'.repeat(60)}end`)
    expect([...label].length).toBeLessThanOrEqual(LABEL_MAX)
    expect(label.endsWith('…')).toBe(true)
  })
  it('the renderer does the same for a saved address source', () => {
    const html = renderToStaticMarkup(createElement(SourceName, { b: { source: sneaky } }))
    expect(html).toBe('docs.example.com › fdp.exex')
    const long = renderToStaticMarkup(createElement(SourceName, { b: { source: `https://docs.example.com/${'word-'.repeat(60)}end` } }))
    expect([...long].length).toBeLessThanOrEqual(LABEL_MAX)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('link and label hardening (#111)', () => {
  it('keepLink rejects a received address holding parentheses, brackets or quotes', () => {
    for (const bad of ['https://a.example/x(1)', 'https://a.example/x)', 'https://a.example/[x]', 'https://a.example/x<y', 'https://a.example/x>', 'https://a.example/"x', "https://a.example/'x"]) {
      expect(keepLink(bad, new Set([bad]))).toBe(false)
    }
    expect(keepLink('https://a.example/x', new Set(['https://a.example/x']))).toBe(true)
  })
  it('every label is cleaned and capped, text sources too', () => {
    const received = receivedUrls(page)
    expect(linkAndLabel(undefined, 'ticket ‮#4821​', received)).toEqual({ source: 'ticket #4821' })
    const long = linkAndLabel(undefined, `call notes ${'x'.repeat(200)}`, received).source!
    expect([...long].length).toBe(LABEL_MAX)
    expect(long.endsWith('…')).toBe(true)
    // nothing left after cleaning: no source at all
    expect(linkAndLabel(undefined, '‮​', received)).toEqual({})
  })
  it('Ask carries a cleaned text label', async () => {
    const ctx = { meetingTitle: 'Sync', focus: null, text: 'ticket #4821: rate limits are per key', preparedAt: 1 }
    const chat = vi.fn<ChatFn>().mockResolvedValue({ content: JSON.stringify({ answer: 'Per key.', source: 'ticket ‮#4821' }) })
    expect((await answerQuestion({ chat, question: 'limits?', context: ctx, lines: [], tools: [], call: vi.fn() })).source).toBe('ticket #4821')
  })
  it('the renderer and the core give the same label for the same source (one implementation)', () => {
    const sources = ['ticket ‮#4821​', `notes ${'y'.repeat(120)}`, 'https://docs.example.com/guides/%E2%80%AEjwt', 'https://docs.example.com/', '  product docs  ']
    for (const s of sources) {
      expect(renderToStaticMarkup(createElement(SourceName, { b: { source: s } }))).toBe(renderToStaticMarkup(createElement('span', null, shownSource(s))).replace(/^<span>|<\/span>$/g, ''))
    }
    expect(shownSource('https://docs.example.com/guides/jwt')).toBe(sourceLabel('https://docs.example.com/guides/jwt'))
    expect(shownSource('ticket ‮#4821')).toBe(cleanLabel('ticket ‮#4821'))
  })
  it('httpsHref passes only https addresses', () => {
    expect(httpsHref(page)).toBe(page)
    expect(httpsHref('HTTPS://docs.example.com/a')).toBe('HTTPS://docs.example.com/a')
    for (const bad of ['javascript:alert(1)', 'http://docs.example.com/a', 'data:text/html,x', 'file:///etc/hosts', 'not a url', '', undefined]) expect(httpsHref(bad)).toBeUndefined()
  })
  it('a bullet with a non-https link shows its label without an href', () => {
    const html = renderToStaticMarkup(createElement(SourceName, { b: { source: 'ticket #4821', url: 'javascript:alert(1)' } }))
    expect(html).toBe('ticket #4821')
    expect(renderToStaticMarkup(createElement(SourceName, { b: { source: 'ticket #4821', url: page } }))).toContain(`href="${page}"`)
  })
  it('Ask answers link only https, and clean their labels', () => {
    const html = renderToStaticMarkup(createElement(OleAnswers, { answers: [
      { id: 'a1', question: 'q1', text: 'one', source: 'ticket ‮#1', url: 'javascript:alert(1)', at: 1 },
      { id: 'a2', question: 'q2', text: 'two', source: 'docs', url: page, at: 2 },
    ] }))
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('‮')
    expect(html).toContain(`href="${page}"`)
  })
  it('a saved meeting from an older version links only https', () => {
    const html = renderToStaticMarkup(createElement(OleSavedBulletsView, {
      bullets: [{ id: 'b1', text: 'old bullet', source: 'notes', url: 'http://plain.example/x', at: 1 }],
      answers: [{ id: 'a1', question: 'q', text: 'a', source: 'notes', url: 'data:text/html,x', at: 1 }],
    }))
    expect(html).not.toContain('href="http://plain')
    expect(html).not.toContain('data:text')
  })
})
