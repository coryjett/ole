import { describe, expect, it, vi } from 'vitest'
import { buildBulletsPrompt, generalTools, hasMatchedRecord, NO_RECORD_RULE } from '../../src/main/ole/bullets'
import { answerQuestion } from '../../src/main/ole/ask'
import { PREPARE_SYSTEM } from '../../src/main/ole/prepare'
import type { ChatFn } from '../../src/main/ole/bullets'
import type { OleTool } from '../../src/main/ole/types'

const ctx = (text: string) => ({ meetingTitle: 'Weekly sync', focus: null, text, preparedAt: 1 })
const tool = (name: string): OleTool => ({ name: `s__${name}`, serverId: 's', serverName: 'S', tool: name, description: name, parameters: { type: 'object' } })
const line = [{ speaker: 'Them', text: 'how does rate limiting work', startMs: 0 }]

describe('calls without a customer account (#57)', () => {
  it('a briefing that matched no account, or no briefing, means no account', () => {
    expect(hasMatchedRecord(null)).toBe(false)
    expect(hasMatchedRecord(ctx(''))).toBe(false)
    expect(hasMatchedRecord(ctx("Couldn't match this call to a meeting or account. Type a company in Focus and press Refresh briefing."))).toBe(false)
    expect(hasMatchedRecord(ctx('No matching record for this call.\n## Who\n- Sam, PM'))).toBe(false)
    // briefings written before #71 used the older wording
    expect(hasMatchedRecord(ctx('No customer account for this call.'))).toBe(false)
    expect(hasMatchedRecord(ctx("Couldn't match this call to a meeting or account."))).toBe(false)
    expect(hasMatchedRecord(ctx('## Before you join\n- Renewal in March (opportunity: Renewal)'))).toBe(true)
  })

  it('Prepare says so on the first line when the meeting has no account', () => {
    expect(PREPARE_SYSTEM).toContain('No matching record for this call.')
  })

  it('the bullets prompt asks for general facts only', () => {
    expect(buildBulletsPrompt({ context: ctx("Couldn't match this call to a meeting or account."), lines: line, previous: [] })[1].content).toContain(NO_RECORD_RULE)
    expect(buildBulletsPrompt({ context: ctx('## Deals\n- x (opportunity: y)'), lines: line, previous: [] })[1].content).not.toContain(NO_RECORD_RULE)
  })

  it('customer-record tools are left out; general ones stay', () => {
    const names = generalTools(['get_account_details', 'get_opportunities', 'get_contacts', 'get_action_items', 'list_poc_trackers', 'get_interactions', 'search_docs', 'get_open_issues', 'get_competitor_detail'].map(tool)).map(t => t.tool)
    expect(names).toEqual(['search_docs', 'get_open_issues', 'get_competitor_detail'])
  })

  it('Ask follows the same rule', async () => {
    const chat = vi.fn<ChatFn>().mockResolvedValue({ content: JSON.stringify({ answer: 'x' }) })
    await answerQuestion({ chat, question: 'q', context: null, lines: [], tools: [], call: vi.fn() })
    expect(chat.mock.calls[0][0].messages[1].content).toContain(NO_RECORD_RULE)
  })
})

describe('general patterns from other customers stay allowed (#57)', () => {
  it('the rule allows anonymised cross-customer patterns and keeps search tools', () => {
    expect(NO_RECORD_RULE).toContain('a common pattern among fintech startups')
    expect(generalTools([tool('search_calls')]).map(t => t.tool)).toEqual(['search_calls'])
  })
})
