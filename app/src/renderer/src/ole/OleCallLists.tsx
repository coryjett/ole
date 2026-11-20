// Ole: the call's open questions and commitments (#82), under the live bullets and on the saved meeting.
// Commitments done during the call (#158) sit below the open ones, checked and struck through.
// Each list is its own card with room between items, a marker per item and the person as a label (#166).
import type { OleCommitment } from '../../../main/ole/core/types'

const item = 'flex items-baseline gap-2 text-[13px] leading-[20px]'

function Who({ who }: { who: string }) {
  return who ? <><span className="ole-who">{who}</span> </> : null
}

export function OleCallLists({ openQuestions = [], commitments = [] }: { openQuestions?: string[]; commitments?: OleCommitment[] }) {
  if (!openQuestions.length && !commitments.length) return null
  // open first, then the ones done during the call (#158), each group in the record's order
  const ordered = [...commitments.filter(c => !c.done), ...commitments.filter(c => c.done)]
  const heading = 'mb-1.5 text-[11px] font-semibold uppercase leading-[16px] tracking-wide'
  return <section data-testid="ole-call-lists" aria-label="Open questions and commitments" className="mt-2 flex flex-col gap-3">
    {openQuestions.length > 0 && <div data-testid="ole-open-questions" className="ole-call-card">
      <p className={heading} style={{ color: 'var(--muted)' }}>Open questions</p>
      <ul role="list" className="flex flex-col gap-1.5">
        {openQuestions.map((q, i) => <li key={i} className={item} dir="auto"><span className="ole-mark" aria-hidden="true">?</span><span>{q}</span></li>)}
      </ul>
    </div>}
    {commitments.length > 0 && <div data-testid="ole-commitments" className="ole-call-card">
      <p className={heading} style={{ color: 'var(--muted)' }}>Commitments</p>
      <ul role="list" className="flex flex-col gap-1.5">
        {ordered.map((c, i) => c.done
          ? <li key={i} data-testid="ole-commitment-done" className={item} style={{ color: 'var(--muted)' }} dir="auto">
            <span aria-hidden="true">✓ </span><span className="sr-only">Done: </span><span className="line-through"><Who who={c.who} />{c.what}</span>
          </li>
          : <li key={i} data-testid="ole-commitment-open" className={item} dir="auto"><span className="ole-mark" aria-hidden="true">○</span><span><Who who={c.who} />{c.what}</span></li>)}
      </ul>
    </div>}
  </section>
}
