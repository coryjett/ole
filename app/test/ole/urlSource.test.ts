import { describe, expect, it } from 'vitest'
import { sourceLabel, urlSource } from '../../src/main/ole/core/bullets'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { SourceName } from '../../src/renderer/src/ole/OleBullets'

const page = 'https://docs.example.com/gateway/latest/documentation/security/authorization/jwt/'

describe('a source that is a web address (#102)', () => {
  it('gets a short readable label', () => {
    expect(sourceLabel(page)).toBe('docs.example.com › jwt')
    expect(sourceLabel('https://example.com/')).toBe('example.com')
    expect(sourceLabel('https://example.com/a/rate_limiting-guide')).toBe('example.com › rate limiting guide')
  })
  it('becomes the link only when Ole received that address', () => {
    expect(urlSource(page, `results: ${page} more`)).toEqual({ source: 'docs.example.com › jwt', url: page })
    expect(urlSource(`${page}.`, `results: ${page}`)).toEqual({ source: 'docs.example.com › jwt', url: page })
    expect(urlSource(page, 'nothing here')).toEqual({ source: 'docs.example.com › jwt' })
    expect(urlSource('product docs', page)).toBeNull()
  })
  it('a saved bullet whose source is an address shows the label', () => {
    const html = renderToStaticMarkup(createElement(SourceName, { b: { source: page } }))
    expect(html).toBe('docs.example.com › jwt')
  })
})
