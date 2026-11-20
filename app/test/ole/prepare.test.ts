import { describe, expect, it, vi } from 'vitest'
import { buildText, pickMeeting, prepareContext, searchAccounts, SECTION_CAP, TOTAL_CAP, TOOL_TIMEOUT_MS } from '../../src/main/ole/prepare'
import { SiestaError, type SiestaClient } from '../../src/main/ole/siesta'

const now = Date.parse('2026-11-19T15:00:00Z')

type Handler = (args: Record<string, unknown>) => string | Promise<string>

function makeClient(handlers: Record<string, Handler>): SiestaClient {
  const listTools = vi.fn(async () => [])
  const callTool = vi.fn(async (name: string, args?: Record<string, unknown>) => {
    const handler = handlers[name]
    if (!handler) throw new Error(`unhandled tool ${name}`)
    return await handler(args ?? {})
  })
  return { listTools, callTool }
}

const iso = (ms: number) => new Date(ms).toISOString()

function meetings(): Array<{ summary: string | null; startTime: string | null; matchedAccountId: string | null }> {
  return [
    { summary: 'Unmatched soon', startTime: iso(now + 10 * 60_000), matchedAccountId: null },
    { summary: 'Matched A1 in 20m', startTime: iso(now + 20 * 60_000), matchedAccountId: 'A1' },
    { summary: 'Matched B2 in 3h', startTime: iso(now + 3 * 60 * 60_000), matchedAccountId: 'B2' },
  ]
}

function accountHandlers(extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    get_upcoming_meetings: () => JSON.stringify(meetings()),
    get_account_details: () => JSON.stringify({ id: 'A1', name: 'Acme Inc' }),
    get_opportunities: () => JSON.stringify([
      { id: 'O1', name: 'Open Deal', isClosed: false },
      { id: 'O2', name: 'Closed Deal', isClosed: true },
    ]),
    get_open_issues: () => JSON.stringify([{ title: 'bug' }]),
    get_action_items: () => JSON.stringify([{ text: 'do it' }]),
    get_interactions: () => JSON.stringify([
      { id: 'C1', title: 'Old call', date: iso(now - 10 * 864e5) },
      { id: 'C2', title: 'New call', date: iso(now - 1 * 864e5) },
    ]),
    list_poc_trackers: () => JSON.stringify([
      { id: 'T-open', accountId: 'A1', status: 'open' },
      { id: 'T-closed', accountId: 'A1', status: 'closed' },
    ]),
    get_competitive_analysis: () => JSON.stringify({ competitors: [] }),
    get_opportunity_feature_requests: (args) => JSON.stringify({ opportunity_id: args.opportunity_id, features: ['fr'] }),
    get_poc_tracker: (args) => JSON.stringify({ tracker_id: args.tracker_id, milestones: [] }),
    get_call_brief: (args) => JSON.stringify({ account_id: args.account_id, call_id: args.call_id, summary: 'brief' }),
    ...extra,
  }
}

describe('pickMeeting', () => {
  it('prefers earliest matched meeting in window', () => {
    const m = pickMeeting(meetings(), now)
    expect(m?.summary).toBe('Matched A1 in 20m')
  })

  it('meetingTitle matches exact then includes', () => {
    const exact = pickMeeting(meetings(), now, 'Unmatched soon')
    expect(exact?.summary).toBe('Unmatched soon')
    const partial = pickMeeting(meetings(), now, 'a1 in 20m')
    expect(partial?.summary).toBe('Matched A1 in 20m')
  })

  it('returns null when no meetings', () => {
    expect(pickMeeting([], now)).toBeNull()
  })
})

describe('buildText', () => {
  it('caps sections and total', () => {
    const big = 'x'.repeat(10_000)
    const text = buildText([
      { label: 'A', body: big },
      { label: 'B', body: big },
    ])
    expect(text).toContain('[truncated]')
    expect(text.length).toBeLessThanOrEqual(TOTAL_CAP)
  })

  it('skips empty bodies', () => {
    const text = buildText([
      { label: 'Empty', body: '' },
      { label: 'Null', body: null },
      { label: 'Ok', body: 'content' },
    ])
    expect(text).toBe('## Ok\ncontent')
  })
})

describe('prepareContext', () => {
  it('chooses account from upcoming meetings and pulls context', async () => {
    const client = makeClient(accountHandlers())
    const ctx = await prepareContext(client, { now })

    expect(ctx.accountId).toBe('A1')
    expect(ctx.accountName).toBe('Acme Inc')
    expect(ctx.meetingTitle).toBe('Matched A1 in 20m')
    expect(ctx.text).toContain('## Account')
    expect(ctx.text).toContain('## Opportunities')
    expect(ctx.text).toContain('Feature requests: Open Deal')
    expect(ctx.text).not.toContain('Feature requests: Closed Deal')

    const calls = client.callTool as unknown as ReturnType<typeof vi.fn>
    const oppCall = calls.mock.calls.find(([name, args]) => name === 'get_opportunity_feature_requests' && (args as Record<string, unknown>).opportunity_id === 'O1')
    expect(oppCall).toBeDefined()

    const pocCall = calls.mock.calls.find(([name, args]) => name === 'get_poc_tracker' && (args as Record<string, unknown>).tracker_id === 'T-open')
    expect(pocCall).toBeDefined()

    const briefCall = calls.mock.calls.find(([name, args]) => name === 'get_call_brief' && (args as Record<string, unknown>).call_id === 'C2')
    expect(briefCall).toBeDefined()
  })

  it('meetingTitle option picks matching meeting', async () => {
    const client = makeClient(accountHandlers())
    const ctx = await prepareContext(client, { now, meetingTitle: 'Matched B2 in 3h' })
    expect(ctx.accountId).toBe('B2')
    expect(ctx.meetingTitle).toBe('Matched B2 in 3h')
  })

  it('no-account path returns empty text and skips per-account tools', async () => {
    const client = makeClient({
      get_upcoming_meetings: () => JSON.stringify([{ summary: 'Intro meeting', startTime: iso(now + 10 * 60_000), matchedAccountId: null }]),
    })
    const ctx = await prepareContext(client, { now })
    expect(ctx.accountId).toBeNull()
    expect(ctx.text).toBe('')
    expect(ctx.meetingTitle).toBe('Intro meeting')

    const calls = client.callTool as unknown as ReturnType<typeof vi.fn>
    expect(calls.mock.calls.some(([name]) => name === 'get_account_details')).toBe(false)
    expect(calls.mock.calls.some(([name]) => name === 'get_opportunities')).toBe(false)
  })

  it('explicit accountId skips get_upcoming_meetings', async () => {
    const client = makeClient(accountHandlers())
    const ctx = await prepareContext(client, { now, accountId: 'A1' })
    expect(ctx.accountId).toBe('A1')
    const calls = client.callTool as unknown as ReturnType<typeof vi.fn>
    expect(calls.mock.calls.some(([name]) => name === 'get_upcoming_meetings')).toBe(false)
  })

  it('failing tool is omitted and others remain', async () => {
    const handlers = accountHandlers({
      get_open_issues: () => { throw new Error('nope') },
    })
    const client = makeClient(handlers)
    const ctx = await prepareContext(client, { now })
    expect(ctx.text).not.toContain('## Open issues')
    expect(ctx.text).toContain('## Account')
    expect(ctx.text).toContain('## Action items')
  })

  it('caps every section when tools return huge payloads', async () => {
    const big = 'x'.repeat(10_000)
    const handlers: Record<string, (args: Record<string, unknown>) => string> = {
      get_upcoming_meetings: () => JSON.stringify(meetings()),
      get_account_details: () => big,
      get_opportunities: () => big,
      get_open_issues: () => big,
      get_action_items: () => big,
      get_interactions: () => JSON.stringify([{ id: 'C1', title: 'call', date: iso(now - 1 * 864e5) }]),
      list_poc_trackers: () => JSON.stringify([{ id: 'T-open', accountId: 'A1', status: 'open' }]),
      get_competitive_analysis: () => big,
      get_opportunity_feature_requests: () => big,
      get_poc_tracker: () => big,
      get_call_brief: () => big,
    }
    const client = makeClient(handlers)
    const ctx = await prepareContext(client, { now })
    expect(ctx.text.length).toBeLessThanOrEqual(TOTAL_CAP)
    const bodies = ctx.text.split(/\n\n(?=## )/).map(s => s.slice(s.indexOf('\n') + 1))
    expect(bodies.length).toBeGreaterThan(1)
    for (const body of bodies) expect(body.length).toBeLessThanOrEqual(SECTION_CAP + '\n[truncated]'.length)
    expect(bodies.filter(b => b === `${'x'.repeat(SECTION_CAP)}\n[truncated]`).length).toBeGreaterThanOrEqual(4)
    const calls = client.callTool as unknown as ReturnType<typeof vi.fn>
    for (const [, , opts] of calls.mock.calls) expect(opts).toEqual({ timeoutMs: TOOL_TIMEOUT_MS })
  })

  it('get_upcoming_meetings auth error rejects', async () => {
    const client = makeClient({
      get_upcoming_meetings: () => { throw new SiestaError('Siesta rejected the key', 'auth') },
    })
    await expect(prepareContext(client, { now })).rejects.toMatchObject({ kind: 'auth', message: 'Siesta rejected the key' })
  })
})

describe('searchAccounts', () => {
  it('maps id/name and does not call on empty query', async () => {
    const client = makeClient({
      search_accounts: () => JSON.stringify([{ id: '1', name: 'Acme' }, { id: '2' }, { name: 'NoId' }]),
    })
    expect(await searchAccounts(client, ' acme ')).toEqual([{ id: '1', name: 'Acme' }])

    const calls = client.callTool as unknown as ReturnType<typeof vi.fn>
    expect(calls.mock.calls.some(([name, args]) => name === 'search_accounts' && (args as Record<string, unknown>).name === 'acme')).toBe(true)

    await searchAccounts(client, '   ')
    expect(calls).toHaveBeenCalledTimes(1)
  })
})
