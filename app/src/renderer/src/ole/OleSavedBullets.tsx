// Ole: the context bullets a finished meeting collected during the call, on its note page.
import { useEffect, useState } from 'react'
import type { OleBullet } from '../../../main/ole/types'
import { OleBriefing } from './OleBriefing'

export function OleSavedBulletsView({ bullets }: { bullets: OleBullet[] }) {
  const [open, setOpen] = useState(true)
  if (!bullets.length) return null
  const sorted = [...bullets].sort((a, b) => b.at - a.at)
  return <section data-testid="ole-saved-bullets" className="settings-group" style={{ padding: 12, margin: '8px 0' }} aria-label="Context from the call">
    <button className="flex w-full items-center justify-between text-left text-[13px] font-semibold" onClick={() => setOpen(v => !v)} aria-expanded={open}>
      <span>Context from the call ({sorted.length})</span><span aria-hidden="true">{open ? '−' : '+'}</span>
    </button>
    {open && <ul role="list" className="mt-2 flex flex-col gap-2">
      {sorted.map(b => <li key={b.id} data-testid="ole-saved-bullet" className="text-[13px] leading-[18px]" dir="auto">
        <span>{b.text}</span>
        {b.heard && <span className="block text-[11px] leading-[16px]" style={{ color: 'var(--muted)' }}>Heard: “{b.heard}”</span>}
        <span className="block text-[11px] leading-[16px]" style={{ color: 'var(--muted)' }}>{b.quote ? `From ${b.source}: “${b.quote}”` : b.source}</span>
      </li>)}
    </ul>}
  </section>
}

export function OleSavedBullets({ meetingId }: { meetingId: string }) {
  const [bullets, setBullets] = useState<OleBullet[]>([])
  const [briefing, setBriefing] = useState('')
  useEffect(() => {
    let alive = true
    void window.yogurt.ole?.bullets?.(meetingId).then(b => { if (alive) setBullets(b) }, () => {})
    void window.yogurt.ole?.briefing?.(meetingId).then(t => { if (alive) setBriefing(t) }, () => {})
    return () => { alive = false }
  }, [meetingId])
  // the briefing the call started from sits with what came up during it (#35)
  return <>{briefing && <div className="settings-group" style={{ padding: 12, margin: '8px 0' }}><OleBriefing text={briefing} defaultOpen={false} /></div>}<OleSavedBulletsView bullets={bullets} /></>
}
