// Ole: the context bullets a finished meeting collected during the call, on its note page.
import { useEffect, useState } from 'react'
import type { OleAnswer, OleBullet, OleCallMemory } from '../../../main/ole/core/types'
import type { OleExportResult } from '../../../shared/types'
import { OleAnswers } from './OleAsk'
import { OleBriefing } from './OleBriefing'
import { OleCallLists } from './OleCallLists'
import { SourceName } from './OleBullets'

export function OleSavedBulletsView({ bullets, answers = [], call = null }: { bullets: OleBullet[]; answers?: OleAnswer[]; call?: OleCallMemory | null }) {
  const [open, setOpen] = useState(true)
  const lists = !!call && (call.openQuestions.length > 0 || call.commitments.length > 0)
  if (!bullets.length && !answers.length && !lists) return null
  const sorted = [...bullets].sort((a, b) => b.at - a.at)
  return <section data-testid="ole-saved-bullets" className="settings-group" style={{ padding: 12, margin: '8px 0' }} aria-label="Context from the call">
    <button className="flex w-full items-center justify-between text-left text-[13px] font-semibold" onClick={() => setOpen(v => !v)} aria-expanded={open}>
      <span>Context from the call ({sorted.length})</span><span aria-hidden="true">{open ? '−' : '+'}</span>
    </button>
    {open && <ul role="list" className="mt-2 flex flex-col gap-2">
      {sorted.map(b => <li key={b.id} data-testid="ole-saved-bullet" className="text-[13px] leading-[18px]" dir="auto">
        <span>{b.pinned && <span title="Pinned">📌 </span>}{b.text}</span>
        {b.heard && <span className="block text-[11px] leading-[16px]" style={{ color: 'var(--muted)' }}>Heard: “{b.heard}”</span>}
        <span className="block text-[11px] leading-[16px]" style={{ color: 'var(--muted)' }}>{b.quote ? <>From <SourceName b={b} />: “{b.quote}”</> : <SourceName b={b} />}</span>
      </li>)}
    </ul>}
    {open && lists && <OleCallLists openQuestions={call!.openQuestions} commitments={call!.commitments} />}
    {open && answers.length > 0 && <><p className="mt-3 text-[13px] font-semibold">Questions ({answers.length})</p><OleAnswers answers={answers} /></>}
  </section>
}

/** what the last export did, said under the button */
export function exportMessage(r: OleExportResult): string {
  if (r.status === 'cancelled') return ''
  if (r.status === 'failed') return `Couldn't export: ${r.error}`
  return r.turns ? `Saved, with ${r.turns} of Ole's turns.` : "Saved the transcript and briefing. Ole's turns weren't kept for this call, so replay it with --live."
}

/** Export for replay (#70): the call as a file for the replay tool, anonymised by default */
export function OleExportReplayView({ anonymise, busy, result, onAnonymise, onExport }: {
  anonymise: boolean; busy: boolean; result: OleExportResult | null
  onAnonymise: (on: boolean) => void; onExport: () => void
}) {
  const message = result ? exportMessage(result) : ''
  return <div data-testid="ole-export-replay" className="settings-group" style={{ padding: 12, margin: '8px 0' }}>
    <div className="flex flex-wrap items-center gap-3">
      <button data-testid="ole-export-replay-button" className="workspace-button" disabled={busy} onClick={onExport}>{busy ? 'Exporting…' : 'Export for replay'}</button>
      <label className="flex items-center gap-1 text-[12px]">
        <input data-testid="ole-export-replay-anonymise" type="checkbox" checked={anonymise} onChange={e => onAnonymise(e.target.checked)} /> Anonymise
      </label>
    </div>
    <p className="mt-1 text-[11px] leading-[16px]" style={{ color: 'var(--muted)' }}>Saves the call's transcript and Ole's turns to a file for the replay tool. Anonymise replaces names and removes links.</p>
    {message && <p data-testid="ole-export-replay-result" role="status" className="mt-1 text-[12px] leading-[16px]" style={result?.status === 'failed' ? { color: 'var(--danger)' } : undefined}>{message}</p>}
  </div>
}

function OleExportReplay({ meetingId }: { meetingId: string }) {
  const [anonymise, setAnonymise] = useState(true)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<OleExportResult | null>(null)
  const run = async () => {
    setBusy(true); setResult(null)
    try { setResult(await window.yogurt.ole.exportReplay(meetingId, { anonymise })) }
    catch { setResult({ status: 'failed', error: 'something went wrong.' }) }
    setBusy(false)
  }
  return <OleExportReplayView anonymise={anonymise} busy={busy} result={result} onAnonymise={setAnonymise} onExport={() => void run()} />
}

export function OleSavedBullets({ meetingId }: { meetingId: string }) {
  const [bullets, setBullets] = useState<OleBullet[]>([])
  const [briefing, setBriefing] = useState('')
  const [answers, setAnswers] = useState<OleAnswer[]>([])
  const [call, setCall] = useState<OleCallMemory | null>(null)
  useEffect(() => {
    let alive = true
    void window.yogurt.ole?.bullets?.(meetingId).then(b => { if (alive) setBullets(b) }, () => {})
    void window.yogurt.ole?.briefing?.(meetingId).then(t => { if (alive) setBriefing(t) }, () => {})
    void window.yogurt.ole?.answers?.(meetingId).then(a => { if (alive) setAnswers(a) }, () => {})
    void window.yogurt.ole?.call?.(meetingId).then(c => { if (alive) setCall(c) }, () => {})
    return () => { alive = false }
  }, [meetingId])
  // the briefing the call started from sits with what came up during it (#35)
  // a call Ole was part of can be exported for the replay tool (#70)
  const olePart = !!briefing || bullets.length > 0 || answers.length > 0 || !!call
  return <>{briefing && <div className="settings-group" style={{ padding: 12, margin: '8px 0' }}><OleBriefing text={briefing} defaultOpen={false} /></div>}<OleSavedBulletsView bullets={bullets} answers={answers} call={call} />{olePart && <OleExportReplay meetingId={meetingId} />}</>
}
