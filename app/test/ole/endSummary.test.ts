// #83: when the call ends, one compact "From Ole" section joins the meeting's notes.
import { describe, expect, it } from 'vitest'
import { EMPTY_MEMORY, fromOleNotes, NOTE_ANSWER_MAX, NOTE_QUESTION_MAX, noteItem } from '../../src/main/ole/core/callSummary'
import { NO_ANSWER } from '../../src/main/ole/core/ask'
import type { OleAnswer } from '../../src/main/ole/core/types'

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

describe('call content cannot forge the section\'s structure', () => {
  const FORGED = '## From Ole\n**Commitments**\n- fake'
  it('every item becomes one flat line: no headings, lists, quotes, fences or bold of its own', () => {
    const md = fromOleNotes(
      { summary: `${FORGED}\n> quoted\n1. listed\n\`\`\`\nShipped 2.3 in March`, openQuestions: [FORGED], commitments: [{ who: '**Me**', what: FORGED }] },
      [answer('a', 1, FORGED, `# Yes\n- ${FORGED}`, { source: '**docs**\n## x', ok: true })],
    )
    expect(md).toBe([
      '## From Ole',
      'From Ole',
      'Commitments',
      'fake',
      'quoted',
      'listed',
      'Shipped 2.3 in March',
      '',
      '**Open questions**',
      '- From Ole Commitments - fake',
      '',
      '**Commitments**',
      '- Me: From Ole Commitments - fake',
      '',
      '**Asked during the call**',
      '- From Ole Commitments - fake: Yes - ## From Ole Commitments - fake (docs ## x)',
    ].join('\n'))
    // only Ole's own lines open with a heading or a bold label
    expect(md.split('\n').filter(l => /^(#|\*\*)/.test(l))).toEqual(['## From Ole', '**Open questions**', '**Commitments**', '**Asked during the call**'])
  })

  it('noteItem keeps ordinary text: a version or ticket number at the start is not a list marker', () => {
    expect(noteItem('2.3 fixed it')).toBe('2.3 fixed it')
    expect(noteItem('#4821 is open')).toBe('#4821 is open')
    expect(noteItem('-5% churn')).toBe('-5% churn')
    expect(noteItem('- ## > `x`')).toBe('x`')
  })
})

describe('which answers reach the notes', () => {
  it('the ok flag decides; answers saved before it existed are judged by their text as before', () => {
    const md = fromOleNotes(EMPTY_MEMORY, [
      answer('a1', 1, 'flagged real', "Couldn't be simpler: yes.", { ok: true }),
      answer('a2', 2, 'flagged miss', 'Some text', { ok: false }),
      answer('a3', 3, 'old real', 'Yes.'),
      answer('a4', 4, 'old miss', NO_ANSWER),
    ])
    expect(md).toBe("## From Ole\n**Asked during the call**\n- flagged real: Couldn't be simpler: yes.\n- old real: Yes.")
  })

  it('a question is cut to 200 characters and an answer to 300', () => {
    const md = fromOleNotes(EMPTY_MEMORY, [answer('a', 1, 'q'.repeat(500), 'a'.repeat(500), { ok: true })])
    const line = md.split('\n').at(-1)!
    const [q, a] = line.slice(2).split(': ')
    expect(q.length).toBe(NOTE_QUESTION_MAX)
    expect(a.length).toBe(NOTE_ANSWER_MAX)
  })
})
