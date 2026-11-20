// Ole: the call's open questions and commitments (#82), compact, under the live bullets and on the saved meeting.
import type { OleCommitment } from '../../../main/ole/types'

export function OleCallLists({ openQuestions = [], commitments = [] }: { openQuestions?: string[]; commitments?: OleCommitment[] }) {
  if (!openQuestions.length && !commitments.length) return null
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
        {commitments.map((c, i) => <li key={i} className="text-[12px] leading-[17px]" dir="auto">{c.who && <span className="font-semibold">{c.who}: </span>}{c.what}</li>)}
      </ul>
    </div>}
  </section>
}
