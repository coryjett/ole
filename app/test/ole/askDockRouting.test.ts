// Ole's docked Ask (#122): ⌘J and the host's Ask button focus Ole's panel during a call on that note, the host's
// Ask everywhere else; Stop cancels the question. Hooks are stubbed, as in motionInteractions.test.ts.
import { afterEach, expect, it, vi } from 'vitest'
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { Ask } from '../../src/renderer/src/components/Chat'
import { Workspace } from '../../src/renderer/src/components/Workspace'
import { OleAskPanel } from '../../src/renderer/src/ole/OleAsk'
import { oleAskTakesOver, registerOleAskDock } from '../../src/renderer/src/ole/oleAskDock'
import type { OleLiveState } from '../../src/shared/types'

vi.mock('react', async original => ({
  ...await original<typeof import('react')>(), useState: vi.fn(), useRef: vi.fn(), useEffect: vi.fn(), useLayoutEffect: vi.fn(),
  useCallback: (callback: unknown) => callback,
}))
vi.mock('react-dom', async original => ({ ...await original<typeof import('react-dom')>(), createPortal: (children: ReactNode) => children }))
const cleanups: Array<() => void> = []
afterEach(() => { cleanups.splice(0).forEach(f => f()); vi.unstubAllGlobals(); vi.clearAllMocks() })

function renderer(component: () => ReactNode) {
  const states: unknown[] = [], refs: { current: unknown }[] = []
  return () => {
    let state = 0, ref = 0
    vi.mocked(useState).mockImplementation((initial?: unknown): [unknown, (next: unknown) => void] => {
      const i = state++
      if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial
      return [states[i], next => { states[i] = typeof next === 'function' ? next(states[i]) : next }]
    })
    vi.mocked(useRef).mockImplementation(initial => refs[ref++] ??= { current: initial })
    vi.mocked(useEffect).mockClear()
    vi.mocked(useLayoutEffect).mockClear()
    return component()
  }
}
function find(node: ReactNode, testId: string): ReactElement<any> {
  const visit = (value: ReactNode): ReactElement<any> | undefined => {
    if (Array.isArray(value)) return value.map(visit).find(Boolean)
    if (!value || typeof value !== 'object' || !('props' in value)) return
    const element = value as ReactElement<any>
    if (element.props['data-testid'] === testId) return element
    return visit(element.props.children)
  }
  const result = visit(node)
  if (!result) throw new Error(`Missing ${testId}`)
  return result
}

const live = (o: Partial<OleLiveState> = {}): OleLiveState => ({
  meetingId: 'm1', preparing: false, error: null, blocked: null, unavailable: [], bullets: [], openQuestions: [], commitments: [], prepared: null, answers: [], ...o,
})

/** ⌘J on a note page clicks the host's Ask button (Workspace), whose handler holds the one seam */
function rig(route: string, noteId: string) {
  const listeners = new Map<string, (e: any) => void>()
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), addEventListener: (name: string, fn: (e: any) => void) => listeners.set(name, fn), removeEventListener() {},
    yogurt: { os: 'darwin', nav: { onAsk: () => () => {}, takeAsk: vi.fn().mockResolvedValue(false) } } })
  const renderAsk = renderer(() => Ask({ id: noteId, recording: true, anchor: null, onSource() {} }))
  let tree = renderAsk()
  const click = vi.fn(() => { find(tree, 'chat-open').props.onClick(); tree = renderAsk() })
  vi.stubGlobal('document', { querySelector: vi.fn().mockReturnValue(null), getElementById: () => ({ click }) })
  const renderWorkspace = renderer(() => Workspace({ route, go() {}, search() {}, collapsed: false, sidebarMotion: false, toggleSidebar() {}, children: null }))
  renderWorkspace()
  vi.mocked(useEffect).mock.lastCall![0]()
  const press = () => listeners.get('keydown')!({ code: 'KeyJ', metaKey: true, ctrlKey: false, preventDefault() {} })
  return { press, hostOpen: () => find(tree, 'chat-open').props['aria-expanded'] as boolean, button: () => { find(tree, 'chat-open').props.onClick(); tree = renderAsk() } }
}

it("⌘J during a call on this note focuses Ole's panel, and the host's Ask stays closed", () => {
  const focus = vi.fn()
  cleanups.push(registerOleAskDock('m1', focus))
  const r = rig('/note/m1', 'm1')
  r.press()
  expect(focus).toHaveBeenCalledTimes(1)
  expect(r.hostOpen()).toBe(false)
})

it("the bottom-bar Ask button during a call on this note focuses Ole's panel too", () => {
  const focus = vi.fn()
  cleanups.push(registerOleAskDock('m1', focus))
  const r = rig('/note/m1', 'm1')
  r.button()
  expect(focus).toHaveBeenCalledTimes(1)
  expect(r.hostOpen()).toBe(false)
})

it("no call on this note (another note's call, or none): the host's Ask opens as before", () => {
  const focus = vi.fn()
  cleanups.push(registerOleAskDock('m2', focus))
  const r = rig('/note/m1', 'm1')
  r.press()
  expect(r.hostOpen()).toBe(true)
  expect(focus).not.toHaveBeenCalled()
  cleanups.splice(0).forEach(f => f())
  expect(oleAskTakesOver('m2')).toBe(false)
  const none = rig('/note/m3', 'm3')
  none.button()
  expect(none.hostOpen()).toBe(true)
})

it('an open host Ask still closes on ⌘J when a call starts on the note', () => {
  const r = rig('/note/m1', 'm1')
  r.press()
  expect(r.hostOpen()).toBe(true)
  const focus = vi.fn()
  cleanups.push(registerOleAskDock('m1', focus))
  r.press()
  expect(r.hostOpen()).toBe(false)
  expect(focus).not.toHaveBeenCalled()
})

it('the docked panel registers while the call can answer, and not while live context is blocked', () => {
  vi.stubGlobal('window', { yogurt: { ole: { ask: vi.fn(), cancelAsk: vi.fn() } } })
  const panel = renderer(() => OleAskPanel({ state: live(), docked: true, meetingId: 'm1' }))
  panel()
  const off = vi.mocked(useEffect).mock.calls[0][0]() as () => void
  expect(oleAskTakesOver('m1')).toBe(true)
  off()
  expect(oleAskTakesOver('m1')).toBe(false)
  const blocked = renderer(() => OleAskPanel({ state: live({ blocked: 'Add an OpenAI key' }), docked: true, meetingId: 'm1' }))
  expect(blocked()).toBeNull()
  expect(vi.mocked(useEffect).mock.calls[0][0]()).toBeUndefined()
  expect(oleAskTakesOver('m1')).toBe(false)
})

it('Ask sends the question with a request id; Stop cancels that request and shows Ask again', async () => {
  let finish: (v: unknown) => void = () => {}
  const ask = vi.fn(() => new Promise(r => { finish = r }))
  const cancelAsk = vi.fn(async () => live())
  vi.stubGlobal('window', { yogurt: { ole: { ask, cancelAsk } } })
  const panel = renderer(() => OleAskPanel({ state: live(), docked: true, meetingId: 'm1' }))
  let tree = panel()
  expect(() => find(tree, 'ole-ask-stop')).toThrow('Missing')
  find(tree, 'ole-ask-input').props.onChange({ target: { value: '  when is the renewal? ' } })
  tree = panel()
  expect(find(tree, 'ole-ask-clear')).toBeDefined()
  find(tree, 'ole-ask-send').props.onClick()
  tree = panel()
  expect(ask).toHaveBeenCalledWith('when is the renewal?', expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/))
  const rid = (ask.mock.calls[0] as unknown[])[1]
  expect(find(tree, 'ole-ask-input').props.value).toBe('')
  find(tree, 'ole-ask-stop').props.onClick()
  expect(cancelAsk).toHaveBeenCalledWith(rid)
  tree = panel()
  expect(find(tree, 'ole-ask-send')).toBeDefined()
  finish(live())
})
