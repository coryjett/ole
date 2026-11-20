import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { Note } from '../../src/renderer/src/screens/Note'
import { OleCallSources, OleQuickNote, OleTabLabel, OleTabPanels } from '../../src/renderer/src/ole/OleNoteTabs'
import { OleAskColumn, OleAskPanel } from '../../src/renderer/src/ole/OleAsk'
import { appendQuickNote, callElapsedMs, callTime, fitTab, oleTabs, quickNoteKey, unseenCount } from '../../src/renderer/src/ole/oleTabs'
import type { MeetingView, NoteView, OleLiveState } from '../../src/shared/types'

describe("Ole's tabs, pure parts (#108)", () => {
  const none = { bullets: 0, answers: 0, lists: 0, briefing: false }
  it('Live and Briefing during a call; after it no Ole tabs at all: Transcript, Summary and My notes (#170)', () => {
    expect(oleTabs(true, null)).toEqual(['live', 'briefing'])
    expect(oleTabs(false, null)).toEqual([])
    expect(oleTabs(false, none)).toEqual([])
    expect(oleTabs(false, { bullets: 2, answers: 1, lists: 3, briefing: true })).toEqual([])
  })
  it('an Ole tab that is gone becomes its counterpart, else My notes', () => {
    expect(fitTab('live', ['context', 'briefing'])).toBe('context')
    expect(fitTab('context', ['live', 'briefing'])).toBe('live')
    expect(fitTab('live', ['briefing'])).toBe('notes')
    expect(fitTab('briefing', [])).toBe('notes')
    expect(fitTab('transcript', [])).toBe('transcript')
    expect(fitTab('briefing', ['briefing'])).toBe('briefing')
  })
  it('counts bullets not seen yet', () => {
    expect(unseenCount(['a', 'b', 'c'], new Set(['a']))).toBe(2)
    expect(unseenCount([], new Set())).toBe(0)
  })
  it('reads the call time from the recorder clock, as mm:ss', () => {
    expect(callElapsedMs({ kind: 'recording', elapsedMs: 60_000, at: 1_000 }, 6_500)).toBe(65_500)
    expect(callElapsedMs({ kind: 'recording', paused: true, elapsedMs: 60_000, at: 1_000 }, 99_000)).toBe(60_000)
    expect(callElapsedMs(null, 5)).toBe(0)
    expect(callTime(65_500)).toBe('01:05')
    expect(callTime(0)).toBe('00:00')
    expect(callTime(75 * 60_000 + 3_000)).toBe('75:03')
  })
  it('appends `- [mm:ss] text` as the last line of My notes, keeping what is there', () => {
    expect(appendQuickNote('', 'Send the deck', 65_000)).toBe('- [01:05] Send the deck')
    expect(appendQuickNote('# Notes\nTyped so far ', 'Send the deck', 5_000)).toBe('# Notes\nTyped so far \n- [00:05] Send the deck')
    expect(appendQuickNote('- one\n\n', '  two\nlines  ', 0)).toBe('- one\n- [00:00] two lines')
  })
  it('does nothing with empty text', () => {
    expect(appendQuickNote('kept', '', 0)).toBeNull()
    expect(appendQuickNote('kept', '   \n ', 0)).toBeNull()
  })
  it('Enter adds; Shift+Enter and composing never do; Esc leaves the field', () => {
    expect(quickNoteKey({ key: 'Enter' })).toBe('add')
    expect(quickNoteKey({ key: 'Enter', shiftKey: true })).toBeNull()
    expect(quickNoteKey({ key: 'Enter', isComposing: true })).toBeNull()
    expect(quickNoteKey({ key: 'Escape' })).toBe('leave')
    expect(quickNoteKey({ key: 'a' })).toBeNull()
  })
})

// The note page with its effects and handlers run, without a browser (the harness of resumeRequest.test.ts).
const hooks = vi.hoisted(() => ({ values: [] as unknown[], refs: [] as { current: unknown }[],
  memos: [] as unknown[], effects: [] as { deps?: unknown[]; run: () => void | (() => void); cleanup?: () => void; pending: boolean }[],
  state: 0, ref: 0, memo: 0, effect: 0 }))
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const i = hooks.state++
    if (!(i in hooks.values)) hooks.values[i] = typeof initial === 'function' ? initial() : initial
    return [hooks.values[i], (next: unknown) => { hooks.values[i] = typeof next === 'function' ? next(hooks.values[i]) : next }]
  },
  useRef: (initial: unknown) => hooks.refs[hooks.ref++] ?? (hooks.refs[hooks.ref - 1] = { current: initial }),
  useMemo: (make: () => unknown) => { const i = hooks.memo++; return hooks.memos[i] ?? (hooks.memos[i] = make()) },
  useLayoutEffect: () => {},
  useEffect: (run: () => void | (() => void), deps?: unknown[]) => {
    const i = hooks.effect++, prev = hooks.effects[i]
    hooks.effects[i] = { run, deps, cleanup: prev?.cleanup, pending: !prev || !deps || deps.some((dep, index) => dep !== prev.deps?.[index]) }
  },
}))
// the note view's width, as the Ask column's ResizeObserver would report it (#148)
const view = vi.hoisted(() => ({ wide: false }))
vi.mock('../../src/renderer/src/ole/oleAskColumn', async original => ({
  ...await original<typeof import('../../src/renderer/src/ole/oleAskColumn')>(), useAskColumnWide: () => ({ ref: () => {}, wide: view.wide }),
}))
vi.mock('../../src/renderer/src/motion', async original => ({ ...await original<typeof import('../../src/renderer/src/motion')>(), useReducedMotion: () => true }))

type El = ReactElement<Record<string, unknown>>
// each test gets its own meeting: the page remembers tabs per meeting for the session
let mid = 'm0', run = 0
let meeting: MeetingView, notes: NoteView, tree: ReactNode
let oleState: OleLiveState, oleChanged: (s: OleLiveState) => void
let saved: { bullets: unknown[]; answers: unknown[]; call: unknown; briefing: string }
const setMine = vi.fn()
const unmount = () => { hooks.effects.forEach(effect => effect.cleanup?.()); hooks.values = []; hooks.refs = []; hooks.memos = []; hooks.effects = [] }
async function render() {
  hooks.state = 0; hooks.ref = 0; hooks.memo = 0; hooks.effect = 0
  tree = Note({ id: mid, onTitleChange: vi.fn(), onSource: vi.fn() })
  for (const effect of hooks.effects) if (effect.pending) {
    effect.cleanup?.()
    effect.cleanup = effect.run() || undefined
    effect.pending = false
  }
  for (let i = 0; i < 6; i++) await Promise.resolve()
}
const settle = async () => { await render(); await render(); await render() }
function find(node: ReactNode, match: (el: El) => boolean): El | undefined {
  if (Array.isArray(node)) return node.map(child => find(child, match)).find(Boolean)
  if (!isValidElement<Record<string, unknown>>(node)) return
  return match(node) ? node : find(node.props.children as ReactNode, match)
}
const byId = (id: string) => find(tree, el => el.props['data-testid'] === id || el.props.testId === id)
const byType = (type: unknown) => find(tree, el => el.type === type)
const click = async (id: string) => { (byId(id)!.props.onClick as (e: { detail: number }) => void)({ detail: 0 }); await render(); await render() }
const selected = (id: string) => byId(id)?.props['aria-selected']
const badge = () => (find(tree, el => el.type === OleTabLabel && el.props.tab === 'live')?.props.unseen as number | undefined) ?? 0
const bullet = (id: string, at: number) => ({ id, text: `Bullet ${id}`, source: 'call', at })

beforeEach(() => {
  vi.clearAllMocks()
  view.wide = false
  mid = `m${++run}`
  meeting = { id: mid, title: 'Kickoff', startedAt: 1, endedAt: null, eventId: 'event', app: null, attendees: [], state: 'recording', language: null, titleSource: 'calendar' } as MeetingView
  notes = { meetingId: mid, mine: '', enhanced: null, edited: false, status: 'idle', draft: '', peopleChanged: false }
  oleState = { meetingId: mid, preparing: false, error: null, blocked: null, unavailable: [], answers: [], bullets: [], openQuestions: [], commitments: [],
    prepared: { meetingTitle: 'Kickoff', focus: null, preparedAt: 1, text: '## Who\n- Someone' } } as unknown as OleLiveState
  saved = { bullets: [], answers: [], call: null, briefing: '' }
  setMine.mockImplementation(async (_id: string, _text: string, revision: number) => ({ revision, status: 'saved' }))
  vi.stubGlobal('window', { matchMedia: () => ({ matches: true }), yogurt: {
    meetings: { get: async () => meeting, onChange: () => vi.fn(), resume: vi.fn(), stop: vi.fn() },
    notes: { stop: vi.fn(), setMine, get: async () => notes, onChange: () => vi.fn() },
    transcript: { get: async () => [], onSegment: () => vi.fn(), onSpeakers: () => vi.fn() },
    setup: { state: async () => ({ phase: 'ready', fraction: 1 }), onState: () => vi.fn() },
    audio: { tracks: async () => [], onDeleted: () => vi.fn() },
    widget: { state: async () => ({ kind: 'recording', paused: true, meetingId: mid, title: 'Kickoff', elapsedMs: 65_000, at: 0, note: null, crashed: false }), onState: () => vi.fn() },
    ole: {
      state: async () => oleState, onState: (cb: typeof oleChanged) => { oleChanged = cb; return vi.fn() },
      bullets: async () => saved.bullets, answers: async () => saved.answers, call: async () => saved.call, briefing: async () => saved.briefing,
    },
  } })
})
afterEach(() => { unmount(); vi.unstubAllGlobals() })

describe("Ole's tabs on the note page (#108)", () => {
  it('a call opens on Live, with Briefing beside Transcript and My notes', async () => {
    await settle()
    expect(byId('note-ole-live-tab')).toBeDefined()
    expect(byId('note-ole-briefing-tab')).toBeDefined()
    expect(byId('note-ole-context-tab')).toBeUndefined()
    expect(selected('note-ole-live-tab')).toBe(true)
    expect(selected('note-transcript-toggle')).toBe(false)
    expect(selected('note-notes-tab')).toBe(false)
    expect(byType(OleTabPanels)?.props.tab).toBe('live')
  })
  it('the tabs take part in the tab bar: click moves, keyboard order starts with Ole', async () => {
    await settle()
    await click('note-ole-briefing-tab')
    expect(selected('note-ole-briefing-tab')).toBe(true)
    expect(byType(OleTabPanels)?.props.tab).toBe('briefing')
    await click('note-notes-tab')
    expect(selected('note-notes-tab')).toBe(true)
    expect(byType(OleTabPanels)?.props.tab).toBeNull()
    expect(byId('note-ole-live-tab')?.props.tabIndex).toBe(-1)
    expect(byId('note-notes-tab')?.props.tabIndex).toBe(0)
  })
  it('a saved meeting has no Ole tabs when Ole kept nothing', async () => {
    meeting = { ...meeting, state: 'done', endedAt: 2 }
    await settle()
    expect(byId('note-ole-live-tab')).toBeUndefined()
    expect(byId('note-ole-context-tab')).toBeUndefined()
    expect(byId('note-ole-briefing-tab')).toBeUndefined()
    expect(byType(OleTabPanels)).toBeUndefined()
    expect(selected('note-notes-tab')).toBe(true)
  })
  it('after the call the sources sit under the Summary, not under My notes (#170)', async () => {
    meeting = { ...meeting, state: 'done', endedAt: 2 }
    notes = { ...notes, enhanced: '## Summary\n- Ship Tuesday', status: 'done' }
    saved = { ...saved, bullets: [bullet('a', 1)] }
    await settle()
    await click('note-summary-tab')
    expect(byType(OleCallSources)).toBeDefined()
    await click('note-notes-tab')
    expect(byType(OleCallSources)).toBeUndefined()
  })
  it('a saved meeting has no Ole tabs, even with bullets and a briefing (#170)', async () => {
    meeting = { ...meeting, state: 'done', endedAt: 2 }
    saved = { ...saved, bullets: [bullet('a', 1)], briefing: '## Who\n- Someone' }
    await settle()
    expect(byId('note-ole-context-tab')).toBeUndefined()
    expect(byId('note-ole-briefing-tab')).toBeUndefined()
    expect(byId('note-ole-live-tab')).toBeUndefined()
  })
  it('Live counts bullets that came while another tab was shown, and clears when shown', async () => {
    oleState = { ...oleState, bullets: [bullet('a', 1)] }
    await settle()
    expect(badge()).toBe(0)
    await click('note-transcript-toggle')
    oleChanged({ ...oleState, bullets: [bullet('a', 1), bullet('b', 2), bullet('c', 3)] }); await render()
    expect(badge()).toBe(2)
    await click('note-ole-live-tab')
    expect(badge()).toBe(0)
    await click('note-notes-tab')
    expect(badge()).toBe(0)
    oleChanged({ ...oleState, bullets: [bullet('a', 1), bullet('b', 2), bullet('c', 3), bullet('d', 4)] }); await render()
    expect(badge()).toBe(1)
  })
})

describe('the quick note (#108)', () => {
  const add = (text: string) => (byType(OleQuickNote)!.props.onAdd as (t: string) => boolean)(text)
  it('shows during a call on every tab but My notes', async () => {
    await settle()
    expect(byType(OleQuickNote)).toBeDefined()
    await click('note-transcript-toggle')
    expect(byType(OleQuickNote)).toBeDefined()
    await click('note-notes-tab')
    expect(byType(OleQuickNote)).toBeUndefined()
    unmount(); meeting = { ...meeting, state: 'done', endedAt: 2 }; saved = { ...saved, briefing: 'x' }
    await settle()
    await click('note-transcript-toggle')
    expect(byType(OleQuickNote)).toBeUndefined()
  })
  it('appends to My notes through the notes save path, after what was typed, without leaving the tab', async () => {
    await settle()
    await click('note-notes-tab')
    ;(byId('note-mine')!.props.onChange as (md: string) => void)('Typed so far')
    await render()
    await click('note-transcript-toggle')
    expect(add('Send the deck')).toBe(true)
    await render(); await render()
    expect(byId('note-mine')?.props.markdown).toBe('Typed so far\n- [01:05] Send the deck')
    expect(setMine).toHaveBeenLastCalledWith(mid, 'Typed so far\n- [01:05] Send the deck', expect.any(Number))
    expect(selected('note-transcript-toggle')).toBe(true)
  })
  it('does nothing with empty text', async () => {
    notes = { ...notes, mine: 'Kept' }
    await settle()
    expect(add('   ')).toBe(false)
    await render()
    expect(setMine).not.toHaveBeenCalled()
    expect(byId('note-mine')?.props.markdown).toBe('Kept')
  })
})

describe('Ask as a column on a wide note (#148)', () => {
  it('narrow: the bottom dock, and the Live tab keeps its answers', async () => {
    await settle()
    expect(byType(OleAskPanel)?.props.docked).toBe(true)
    expect(byType(OleAskColumn)).toBeUndefined()
    expect(byType(OleTabPanels)?.props.askColumn).toBe(false)
  })
  it('wide: the column on every tab instead of the dock, and the Live tab leaves its answers to it', async () => {
    view.wide = true
    await settle()
    expect(byType(OleAskColumn)?.props.meetingId).toBe(mid)
    expect(byType(OleAskPanel)).toBeUndefined()
    expect(byType(OleTabPanels)?.props.askColumn).toBe(true)
    for (const tab of ['note-ole-briefing-tab', 'note-transcript-toggle', 'note-notes-tab']) {
      await click(tab)
      expect(byType(OleAskColumn)).toBeDefined()
      expect(byType(OleAskPanel)).toBeUndefined()
    }
  })
  it('wide but blocked, or after the call: no column, and the Live tab keeps its answers', async () => {
    view.wide = true
    oleState = { ...oleState, blocked: 'Add an OpenAI key' }
    await settle()
    expect(byType(OleAskColumn)).toBeUndefined()
    expect(byType(OleTabPanels)?.props.askColumn).toBe(false)
    unmount(); meeting = { ...meeting, state: 'done', endedAt: 2 }; saved = { ...saved, answers: [{ id: 'a', question: 'Q?', text: 'A.', at: 1 }] }
    await settle()
    expect(byType(OleAskColumn)).toBeUndefined()
    expect(byType(OleAskPanel)).toBeUndefined()
  })
})
