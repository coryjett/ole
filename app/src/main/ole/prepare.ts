// Ole: pre-call warm-up. Picks the account from Siesta's upcoming meetings, then pulls that account's context
// from Siesta's MCP tools in parallel into one labelled text block for the assistant.
import type { PreparedContext } from './types'
import type { SiestaClient } from './siesta'

export const TOOL_TIMEOUT_MS = 15_000
export const SECTION_CAP = 4000
export const TOTAL_CAP = 24_000
export const LOOKAHEAD_MS = 60 * 60_000
const GRACE_MS = 5 * 60_000 // a meeting that started a few minutes ago still counts
const CALL_HISTORY_MS = 60 * 864e5
const MAX_OPPS = 3
const MAX_BRIEFS = 2

export type UpcomingMeeting = { summary: string | null; startTime: string | null; matchedAccountId: string | null; externalDomain?: string | null }
type Row = Record<string, unknown>

function parseJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return null }
}

const rows = (text: string | null): Row[] => {
  const parsed = text == null ? null : parseJson(text)
  return Array.isArray(parsed) ? parsed.filter((r): r is Row => !!r && typeof r === 'object' && !Array.isArray(r)) : []
}
const str = (v: unknown) => typeof v === 'string' && v ? v : null

export function pickMeeting(meetings: UpcomingMeeting[], now: number, meetingTitle?: string): UpcomingMeeting | null {
  if (meetingTitle) {
    const want = meetingTitle.trim().toLowerCase()
    return meetings.find(m => m.summary?.toLowerCase() === want)
      ?? meetings.find(m => m.summary?.toLowerCase().includes(want)) ?? null
  }
  const inWindow = meetings
    .map(m => ({ m, t: m.startTime ? Date.parse(m.startTime) : NaN }))
    .filter(({ t }) => t >= now - GRACE_MS && t <= now + LOOKAHEAD_MS)
    .sort((a, b) => a.t - b.t)
    .map(({ m }) => m)
  return inWindow.find(m => m.matchedAccountId) ?? inWindow[0] ?? null
}

function trimTo(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}\n[truncated]` : s
}

export function buildText(sections: Array<{ label: string; body: string | null }>): string {
  let text = ''
  for (const { label, body } of sections) {
    const trimmed = body?.trim()
    if (!trimmed) continue
    const chunk = `${text ? '\n\n' : ''}## ${label}\n${trimTo(trimmed, SECTION_CAP)}`
    if (text.length + chunk.length > TOTAL_CAP) {
      text += chunk.slice(0, TOTAL_CAP - text.length)
      break
    }
    text += chunk
  }
  return text
}

export async function prepareContext(client: SiestaClient, opts: { meetingTitle?: string; accountId?: string; now?: number } = {}): Promise<PreparedContext> {
  const now = opts.now ?? Date.now()
  let meetingTitle = opts.meetingTitle ?? null
  let accountId = opts.accountId ?? null

  if (!accountId) {
    // Auth and VPN errors surface here on purpose: the caller shows them
    const meetings = rows(await client.callTool('get_upcoming_meetings', { days: 1 }, { timeoutMs: TOOL_TIMEOUT_MS })) as UpcomingMeeting[]
    const meeting = pickMeeting(meetings, now, opts.meetingTitle)
    meetingTitle = meeting?.summary ?? meetingTitle
    accountId = meeting?.matchedAccountId ?? null
  }
  if (!accountId) return { meetingTitle, accountId: null, accountName: null, text: '', preparedAt: now }

  const account_id = accountId
  // A failed or slow tool is just left out
  const call = (name: string, args: Record<string, unknown>): Promise<string | null> =>
    client.callTool(name, args, { timeoutMs: TOOL_TIMEOUT_MS }).catch(() => null)

  const [account, opps, issues, actions, calls, trackers, competitive] = await Promise.all([
    call('get_account_details', { account_id }),
    call('get_opportunities', { account_id }),
    call('get_open_issues', { account_id }),
    call('get_action_items', { account_id }),
    call('get_interactions', { account_id, source_types: ['gong_call'], from_date: new Date(now - CALL_HISTORY_MS).toISOString() }),
    call('list_poc_trackers', {}),
    call('get_competitive_analysis', {}),
  ])

  const accountRow = parseJson(account ?? '') as Row | null
  const accountName = accountRow && typeof accountRow === 'object' ? str(accountRow.name) : null
  const openOpps = rows(opps).filter(o => o.isClosed === false && str(o.id)).slice(0, MAX_OPPS)
  const accountTrackers = rows(trackers).filter(t => t.accountId === account_id && str(t.id))
  const tracker = accountTrackers.find(t => t.status === 'open') ?? accountTrackers[0]
  const recentCalls = rows(calls).filter(c => str(c.id))
    .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? ''))).slice(0, MAX_BRIEFS)

  const [frs, poc, briefs] = await Promise.all([
    Promise.all(openOpps.map(o => call('get_opportunity_feature_requests', { opportunity_id: o.id }))),
    tracker ? call('get_poc_tracker', { tracker_id: tracker.id }) : Promise.resolve(null),
    Promise.all(recentCalls.map(c => call('get_call_brief', { account_id, call_id: c.id }))),
  ])

  const text = buildText([
    { label: 'Account', body: account },
    { label: 'Opportunities', body: opps },
    ...openOpps.map((o, i) => ({ label: `Feature requests: ${str(o.name) ?? o.id}`, body: frs[i] })),
    { label: 'POC tracker', body: poc },
    { label: 'Open issues', body: issues },
    { label: 'Action items', body: actions },
    { label: 'Recent calls', body: calls },
    ...recentCalls.map((c, i) => ({ label: `Call brief: ${str(c.title) ?? c.id}`, body: briefs[i] })),
    { label: 'Competitive landscape', body: competitive },
  ])
  return { meetingTitle, accountId, accountName, text, preparedAt: now }
}

// Account switcher: Siesta's search_accounts takes `name`
export async function searchAccounts(client: SiestaClient, query: string): Promise<Array<{ id: string; name: string }>> {
  if (!query.trim()) return []
  const found = rows(await client.callTool('search_accounts', { name: query.trim() }, { timeoutMs: TOOL_TIMEOUT_MS }))
  return found.flatMap(r => str(r.id) && str(r.name) ? [{ id: r.id as string, name: r.name as string }] : [])
}
