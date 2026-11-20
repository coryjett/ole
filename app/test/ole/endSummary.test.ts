// #83: when the call ends, one compact "From Ole" section joins the meeting's notes.
import { describe, expect, it } from 'vitest'
import { EMPTY_MEMORY, fromOleNotes } from '../../src/main/ole/callSummary'
import { NO_ANSWER } from '../../src/main/ole/ask'
import type { OleAnswer } from '../../src/main/ole/types'

const memory = { summary: 'They want rate limits for the morning burst.\nPilot starts in January.', openQuestions: ['Is there a free tier?'], commitments: [{ who: 'Me', what: 'Send the benchmark plan' }, { who: '', what: 'Book the security review' }] }
const answer = (id: string, at: number, question: string, text: string, extra: Partial<OleAnswer> = {}): OleAnswer => ({ id, at, question, text, ...extra })

describe('the "From Ole" notes section (#83)', () => {
  it('summary, open questions, commitments and the questions asked, oldest first', () => {
    const answers = [
      answer('a3', 30, 'and  the second\none?', 'The waypoint.', { source: 'product docs' }),
      answer('a2', 20, 'not found', NO_ANSWER),
      answer('a1', 10, 'what shipped in 2.3?', 'Burst limits.'),
      answer('a4', 40, 'still going', '', { pending: true }),
      answer('a5', 50, 'broken', "Couldn't answer: timeout"),
    ]
    expect(fromOleNotes(memory, answers)).toBe([
      '## From Ole',
      'They want rate limits for the morning burst.',
      'Pilot starts in January.',
      '',
      '**Open questions**',
      '- Is there a free tier?',
      '',
      '**Commitments**',
      '- Me: Send the benchmark plan',
      '- Book the security review',
      '',
      '**Asked during the call**',
      '- what shipped in 2.3?: Burst limits.',
      '- and the second one?: The waypoint. (product docs)',
    ].join('\n'))
  })

  it('leaves out what is empty, and is empty when Ole kept nothing', () => {
    expect(fromOleNotes({ ...EMPTY_MEMORY, openQuestions: ['Q?'] })).toBe('## From Ole\n**Open questions**\n- Q?')
    expect(fromOleNotes(EMPTY_MEMORY, [answer('a', 1, 'q', 'A.')])).toBe('## From Ole\n**Asked during the call**\n- q: A.')
    expect(fromOleNotes(EMPTY_MEMORY)).toBe('')
    expect(fromOleNotes(EMPTY_MEMORY, [answer('a', 1, 'q', NO_ANSWER)])).toBe('')
  })
})
