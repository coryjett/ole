// Ole: the call's open questions and commitments (#82), compact, under the live bullets and on the saved meeting.
// Commitments done during the call (#158) sit below the open ones, checked and struck through.
import type { OleCommitment } from '../../../main/ole/core/types'

export function OleCallLists({ openQuestions = [], commitments = [] }: { openQuestions?: string[]; commitments?: OleCommitment[] }) {
  if (!openQuestions.length && !commitments.length) return null
  // open first, then the ones done during the call (#158), each group in the record's order
  const ordered = [...commitments.filter(c => !c.done), ...commitments.filter(c => c.done)]
  const heading = 'text-[11px] font-semibold uppercase leading-[16px] tracking-wide'
  return <section data-testid="ole-call-lists" aria-label="Open questions and commitments" className="mt-2 flex flex-col gap-2">
    {openQuestions.length > 0 && <div data-testid="ole-open-questions">
      <p className={heading} style={{ color: 'var(--muted)' }}>Open questions</p>
      <ul role="list" className="flex flex-col gap-0.5">
        {openQuestions.map((q, i) => <li key={i} className="text-[12px] leading-[17px]" dir="auto">{q}</li>)}
      </ul>
    </div>}
    {commitments.length > 0 && <div data-testid="ole-commitments">
      <p className={heading} style={{ color: 'var(--muted)' }}>Commitments</p>
      <ul role="list" className="flex flex-col gap-0.5">
        {ordered.map((c, i) => c.done
          ? <li key={i} data-testid="ole-commitment-done" className="text-[12px] leading-[17px]" style={{ color: 'var(--muted)' }} dir="auto">
            <span aria-hidden="true">✓ </span><span className="sr-only">Done: </span><span className="line-through">{c.who && <span className="font-semibold">{c.who}: </span>}{c.what}</span>
          </li>
          : <li key={i} data-testid="ole-commitment-open" className="text-[12px] leading-[17px]" dir="auto">{c.who && <span className="font-semibold">{c.who}: </span>}{c.what}</li>)}
      </ul>
    </div>}
  </section>
}
