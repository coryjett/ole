import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BULLETS_SYSTEM, parseBulletItem } from '../../src/main/ole/core/bullets'
import { loudBullets, NOW_MAX, spotlight } from '../../src/main/ole/core/spotlight'
import type { OleBullet } from '../../src/main/ole/core/types'
import { OleBullets } from '../../src/renderer/src/ole/OleBullets'

const b = (id: string, at: number, act = false): OleBullet => ({ id, text: `Fact ${id}`, source: 'issue #1', at, ...(act ? { act: true as const } : {}) })

describe('the model marks what matters (#172)', () => {
  it('asks for "act" and keeps only an exact true', () => {
    expect(BULLETS_SYSTEM).toContain('"act": true')
    expect(parseBulletItem({ text: 'Same 429s, fixed in 2.3', source: 'issue #412', act: true })).toMatchObject({ act: true })
    expect(parseBulletItem({ text: 'Same 429s, fixed in 2.3', source: 'issue #412' })).not.toHaveProperty('act')
    expect(parseBulletItem({ text: 'Same 429s, fixed in 2.3', source: 'issue #412', act: 'yes' })).not.toHaveProperty('act')
  })
})

describe('spotlight (#172)', () => {
  it('the newest act bullets are Right now; everything else is Earlier, newest first', () => {
    const s = spotlight([b('a', 1, true), b('bg', 2), b('c', 3, true), b('d', 4, true), b('bg2', 5)])
    expect(NOW_MAX).toBe(2)
    expect(s.now.map(x => x.id)).toEqual(['d', 'c'])
    expect(s.earlier.map(x => x.id)).toEqual(['bg2', 'bg', 'a'])
  })
  it('no act bullets: nothing Right now', () => {
    expect(spotlight([b('x', 1), b('y', 2)])).toEqual({ now: [], earlier: [b('y', 2), b('x', 1)] })
  })
  it('only act bullets are loud (the floating window and the Live badge)', () => {
    expect(loudBullets([b('a', 1, true), b('bg', 2)]).map(x => x.id)).toEqual(['a'])
  })
})

describe('the Live tab in spotlight mode (#172)', () => {
  it('Right now cards for act bullets; the rest folded under Earlier', () => {
    const html = renderToStaticMarkup(createElement(OleBullets, { bullets: [b('a', 1, true), b('bg', 2)], prepared: null, spotlight: true, header: false, maxHeight: 'none' }))
    expect(html).toContain('Right now')
    const now = html.slice(html.indexOf('data-testid="ole-now"'), html.indexOf('data-testid="ole-earlier"'))
    expect(now).toContain('class="ole-now-card"')
    expect(now).toContain('Fact a')
    expect(now).not.toContain('Fact bg')
    expect(html).toContain('Earlier (1)')
    expect(html).not.toContain('Fact bg')
  })
  it('without the spotlight (a saved meeting, the widget) it is the plain list', () => {
    const html = renderToStaticMarkup(createElement(OleBullets, { bullets: [b('a', 1, true), b('bg', 2)], prepared: null }))
    expect(html).not.toContain('Right now')
    expect(html).toContain('Fact bg')
  })
})
