import { describe, expect, it } from 'vitest'
import { serverEvent } from '../../src/main/ole/yogurt/serverCalendar'

const m = (id: string, title: string) => ({ id, title, start: 1, end: 2 }) as never

describe('server calendar hardening (#152)', () => {
  it('event ids are a fixed-length hash, never the raw server id', () => {
    const a = serverEvent(m('../../etc/passwd\u0000', 'T'), 'S').id
    expect(a).toMatch(/^ole-server:[0-9a-f]{32}$/)
    expect(serverEvent(m('../../etc/passwd\u0000', 'T'), 'S').id).toBe(a)
    expect(serverEvent(m('other', 'T'), 'S').id).not.toBe(a)
  })
  it('titles drop control characters and are capped', () => {
    const e = serverEvent(m('x', `Demo\u0000‮\u0007 day${'!'.repeat(400)}`), 'S')
    expect(e.title).not.toMatch(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/)
    expect(e.title.length).toBeLessThanOrEqual(200)
    expect(e.title.startsWith('Demo day')).toBe(true)
  })
})
