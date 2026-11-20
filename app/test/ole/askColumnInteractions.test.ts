// The Ask column's behavior (#148): collapse and open remembered, ⌘J and the Ask button opening a collapsed column and
// focusing its box, Stop, and following the newest answer. Hooks are stubbed, as in askDockRouting.test.ts.
import { afterEach, expect, it, vi } from 'vitest'
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { OleAskColumn } from '../../src/renderer/src/ole/OleAsk'
import { oleAskTakesOver } from '../../src/renderer/src/ole/oleAskDock'
import { ASK_COLUMN_KEY } from '../../src/renderer/src/ole/oleAskColumn'
import type { OleLiveState } from '../../src/shared/types'

vi.mock('react', async original => ({
  ...await original<typeof import('react')>(), useState: vi.fn(), useRef: vi.fn(), useEffect: vi.fn(), useLayoutEffect: vi.fn(),
}))
const cleanups: Array<() => void> = []
afterEach(() => { cleanups.splice(0).forEach(f => f()); vi.unstubAllGlobals(); vi.clearAllMocks() })

function renderer(component: () => ReactNode) {
  const states: unknown[] = [], refs: { current: unknown }[] = []
  const render = () => {
    let state = 0, ref = 0
    vi.mocked(useState).mockImplementation((initial?: unknown): [unknown, (next: unknown) => void] => {
      const i = state++
      if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial
      return [states[i], next => { states[i] = typeof next === 'function' ? next(states[i]) : next }]
    })
    vi.mocked(useRef).mockImplementation(initial => refs[ref++] ??= { current: initial })
    vi.mocked(useEffect).mockClear()
    return component()
  }
  /** the effects of the last render, in order: register, focus, follow the newest */
  const effect = (i: number) => vi.mocked(useEffect).mock.calls[i][0]() as (() => void) | undefined
  return { render, effect }
}
function find(node: ReactNode, testId: string): ReactElement<any> | undefined {
  if (Array.isArray(node)) return node.map(n => find(n, testId)).find(Boolean)
  if (!node || typeof node !== 'object' || !('props' in node)) return
  const element = node as ReactElement<any>
  if (element.props['data-testid'] === testId) return element
  return find(element.props.children, testId)
}
const live = (o: Partial<OleLiveState> = {}): OleLiveState => ({
  meetingId: 'm1', preparing: false, error: null, blocked: null, unavailable: [], bullets: [], openQuestions: [], commitments: [], prepared: null, answers: [], ...o,
})
function rig(stored: Record<string, string> = {}, state = live()) {
  const data = new Map(Object.entries(stored))
  const ask = vi.fn(() => new Promise(() => {}))
  const cancelAsk = vi.fn(async () => live())
  vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) } })
  vi.stubGlobal('window', { matchMedia: () => ({ matches: true }), yogurt: { ole: { ask, cancelAsk } } })
  const r = renderer(() => OleAskColumn({ state, meetingId: 'm1' }))
  return { ...r, data, ask, cancelAsk }
}
/** a stand-in DOM element on a ref the render handed out */
const fake = (tree: ReactNode, id: string) => {
  const el = { focus: vi.fn(), scrollTo: vi.fn(), scrollHeight: 640 }
  find(tree, id)!.props.ref.current = el
  return el
}

it('collapse remembers the choice and shows the strip, which gets focus; opening it remembers too and focuses the box', () => {
  const r = rig()
  let tree = r.render()
  expect(find(tree, 'ole-ask-column')).toBeDefined()
  find(tree, 'ole-ask-collapse')!.props.onClick()
  expect(r.data.get(ASK_COLUMN_KEY)).toBe('1')
  tree = r.render()
  expect(find(tree, 'ole-ask-column')).toBeUndefined()
  const strip = fake(tree, 'ole-ask-expand')
  r.effect(1)
  expect(strip.focus).toHaveBeenCalledTimes(1)
  find(tree, 'ole-ask-expand')!.props.onClick()
  expect(r.data.get(ASK_COLUMN_KEY)).toBe('0')
  tree = r.render()
  const input = fake(tree, 'ole-ask-input')
  r.effect(1)
  expect(input.focus).toHaveBeenCalledTimes(1)
})

it('⌘J and the Ask button (oleAskTakesOver) open a collapsed column and focus its box', () => {
  const r = rig({ [ASK_COLUMN_KEY]: '1' })
  let tree = r.render()
  expect(find(tree, 'ole-ask-strip')).toBeDefined()
  const off = r.effect(0)!
  cleanups.push(off)
  expect(oleAskTakesOver('m1')).toBe(true)
  expect(r.data.get(ASK_COLUMN_KEY)).toBe('0')
  tree = r.render()
  expect(find(tree, 'ole-ask-column')).toBeDefined()
  const input = fake(tree, 'ole-ask-input')
  r.effect(1)
  expect(input.focus).toHaveBeenCalledTimes(1)
  // already open: focused straight away, nothing rewritten
  r.data.delete(ASK_COLUMN_KEY)
  expect(oleAskTakesOver('m1')).toBe(true)
  expect(input.focus).toHaveBeenCalledTimes(2)
  expect(r.data.has(ASK_COLUMN_KEY)).toBe(false)
  off()
  expect(oleAskTakesOver('m1')).toBe(false)
})

it('does not register for another meeting, or while live context is blocked', () => {
  const other = rig({}, live({ meetingId: 'm2' }))
  expect(other.render()).toBeNull()
  expect(other.effect(0)).toBeUndefined()
  const blocked = rig({}, live({ blocked: 'Add an OpenAI key' }))
  expect(blocked.render()).toBeNull()
  expect(blocked.effect(0)).toBeUndefined()
  expect(oleAskTakesOver('m1')).toBe(false)
})

it('Ask sends with a request id and this meeting; Stop cancels that request', () => {
  const r = rig()
  let tree = r.render()
  find(tree, 'ole-ask-input')!.props.onChange({ target: { value: ' who signs? ' } })
  tree = r.render()
  find(tree, 'ole-ask-send')!.props.onClick()
  tree = r.render()
  expect(r.ask).toHaveBeenCalledWith('who signs?', expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/), 'm1')
  find(tree, 'ole-ask-stop')!.props.onClick()
  expect(r.cancelAsk).toHaveBeenCalledWith((r.ask.mock.calls[0] as unknown[])[1])
  tree = r.render()
  expect(find(tree, 'ole-ask-send')).toBeDefined()
})

it('follows the newest answer, jumping instead of gliding under reduced motion', () => {
  const r = rig({}, live({ answers: [{ id: 'a1', question: 'Q?', text: 'A.', at: 1 }] }))
  const tree = r.render()
  const list = fake(tree, 'ole-ask-answers')
  r.effect(2)
  expect(list.scrollTo).toHaveBeenCalledWith({ top: 640, behavior: 'auto' })
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) })
  r.effect(2)
  expect(list.scrollTo).toHaveBeenLastCalledWith({ top: 640, behavior: 'smooth' })
  const deps = vi.mocked(useEffect).mock.calls[2][1]
  expect(deps).toEqual([1, 'a1', undefined, false])
})
