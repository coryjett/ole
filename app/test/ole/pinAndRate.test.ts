import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildBulletsPrompt, createBulletsEngine, pinnedNotes } from '../../src/main/ole/bullets'
import type { ChatFn } from '../../src/main/ole/bullets'
import { feedbackOf, recordRating, FEEDBACK_KEEP } from '../../src/main/ole/feedback'

vi.mock('electron', () => ({ ipcMain: { handle: () => {} } }))

const ctx = { meetingTitle: 'Acme', focus: null, text: '## Deals\n- Platform expansion, 120k (opportunity: Platform expansion)', preparedAt: 1 }
const reply = (bullets: unknown[]) => ({ content: JSON.stringify({ bullets }) })

async function engineWithOne() {
  const chat = vi.fn<ChatFn>().mockResolvedValue(reply([{ text: 'Expansion deal is 120k', source: 'opportunity: Platform expansion' }]))
  let all: Array<{ id: string; pinned?: boolean; rating?: string }> = []
  const engine = createBulletsEngine({ chat, tools: () => [], callTool: vi.fn(), context: () => ctx, onBullets: b => { all = b }, minIntervalMs: 0 })
  engine.push({ speaker: 'Them', text: 'how big is the expansion', startMs: 0 })
  await vi.waitFor(() => expect(all).toHaveLength(1))
  return { engine, chat, all: () => all }
}

describe('pin a bullet (#54)', () => {
  it('pins and unpins a bullet in place and tells the panel', async () => {
    const { engine, all } = await engineWithOne()
    const id = all()[0].id
    expect(engine.update(id, { pinned: true })?.pinned).toBe(true)
    expect(all()[0].pinned).toBe(true)
    expect(engine.update(id, { pinned: false })?.pinned).toBeUndefined()
    expect(engine.update('nope', { pinned: true })).toBeNull()
  })

  it('pinned bullets become a "Pinned from the call" notes section with their sources', () => {
    const md = pinnedNotes([
      { id: 'b1', text: 'Expansion deal is 120k', source: 'opportunity: Platform expansion', at: 1, pinned: true, url: 'https://crm.example/o/1' },
      { id: 'b2', text: 'Not pinned', source: 'docs', at: 2 },
    ])
    expect(md).toBe('## Pinned from the call\n- Expansion deal is 120k ([opportunity: Platform expansion](https://crm.example/o/1))')
    expect(pinnedNotes([{ id: 'b2', text: 'Not pinned', source: 'docs', at: 2 }])).toBe('')
  })
})

describe('thumbs up or down (#55)', () => {
  it('a rating is stored on the bullet; null clears it', async () => {
    const { engine, all } = await engineWithOne()
    const id = all()[0].id
    expect(engine.update(id, { rating: 'down' })?.rating).toBe('down')
    expect(engine.update(id, { rating: null })?.rating).toBeUndefined()
  })

  it('the prompt marks down-rated bullets and carries examples from earlier calls', () => {
    const msgs = buildBulletsPrompt({
      context: ctx, lines: [{ speaker: 'Them', text: 'hi', startMs: 0 }],
      previous: [{ id: 'b1', text: 'Generic advice', source: 'docs', at: 1, rating: 'down' }, { id: 'b2', text: 'Same 429s at a fintech', source: 'issue #412', at: 2, rating: 'up' }],
      feedback: { useful: ['Fixed in 2.3, same error'], notUseful: ['Consider asking about timelines'] },
    })
    const user = msgs[1].content ?? ''
    expect(user).toContain('- Generic advice (the user marked this not useful)')
    expect(user).toContain('- Same 429s at a fintech (the user marked this useful)')
    expect(user).toContain('Bullets the user found useful on earlier calls:\n- Fixed in 2.3, same error')
    expect(user).toContain('Bullets the user found not useful on earlier calls (give none like these):\n- Consider asking about timelines')
  })

  it('ratings are kept across calls, newest first, at most FEEDBACK_KEEP each, and a cleared one is forgotten', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ole-fb-')), 'settings.json')
    for (let i = 0; i < FEEDBACK_KEEP + 3; i++) recordRating(file, `useful ${i}`, 'up')
    recordRating(file, 'meh', 'down')
    let fb = feedbackOf(file)
    expect(fb.useful).toHaveLength(FEEDBACK_KEEP)
    expect(fb.useful[0]).toBe(`useful ${FEEDBACK_KEEP + 2}`)
    expect(fb.notUseful).toEqual(['meh'])
    recordRating(file, 'meh', 'up')
    fb = feedbackOf(file)
    expect(fb.notUseful).toEqual([])
    expect(fb.useful[0]).toBe('meh')
    recordRating(file, 'meh', null)
    expect(feedbackOf(file).useful).not.toContain('meh')
  })
})
