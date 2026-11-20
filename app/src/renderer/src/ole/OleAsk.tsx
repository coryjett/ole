// Ole: ask a question during the call (#53). The answer comes from the briefing, the call so far and, when needed, a
// read-only lookup; each answer names its source and links it when Ole has the link.
import { useState } from 'react'
import type { OleAnswer } from '../../../main/ole/core/types'
import { SourceName } from './OleBullets'

export function OleAnswers({ answers }: { answers: OleAnswer[] }) {
  if (!answers.length) return null
  return <ul data-testid="ole-answers" role="list" className="mt-2 flex flex-col gap-1">
    {answers.map(a => <li key={a.id} data-testid="ole-answer" className="widget-preview-bubble text-[13px] leading-[18px]" dir="auto">
      <span className="block text-[11px] leading-[16px] text-[#B8B8C0]">Q: {a.question}</span>
      {a.pending ? <span className="opacity-70">Looking…</span> : <span>{a.text}</span>}
      {a.source && <span className="block text-[11px] leading-[16px] text-[#B8B8C0]">
        <SourceName b={{ source: a.source, url: a.url }} /></span>}
    </li>)}
  </ul>
}

export function OleAsk({ answers, disabled }: { answers: OleAnswer[]; disabled?: boolean }) {
  const [q, setQ] = useState('')
  const ask = () => { const question = q.trim(); if (!question) return; setQ(''); void window.yogurt.ole.ask(question) }
  return <section data-testid="ole-ask" aria-label="Ask Ole" className="mt-2">
    <div className="flex items-center gap-1">
      <input data-testid="ole-ask-input" className="settings-input w-full" placeholder="Ask Ole about this call…" value={q} maxLength={500} disabled={disabled}
        onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') ask() }} />
      {q && <button aria-label="Clear" className="workspace-button" onClick={() => setQ('')}>×</button>}
      <button data-testid="ole-ask-send" className="workspace-button" disabled={disabled || !q.trim()} onClick={ask}>Ask</button>
    </div>
    <OleAnswers answers={answers} />
  </section>
}
