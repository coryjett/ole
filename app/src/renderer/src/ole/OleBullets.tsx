// Ole: the live context bullets, newest first, each with its source. The list has a fixed height and scrolls, and only
// the newest few are open; older ones fold behind "Show N earlier", so a long call never pushes the notes away (#38).
import { useState } from 'react'
import type { OleBullet } from '../../../main/ole/types'

export type OlePrepared = { meetingTitle: string | null; focus: string | null }

/** bullets shown before the rest fold away */
export const BULLETS_OPEN = 4
/** how long a new bullet stays highlighted */
export const NEW_MS = 8000

export function OleBullets({ bullets, prepared, maxHeight = 320, now = Date.now() }: { bullets: OleBullet[]; prepared: OlePrepared | null; maxHeight?: number; now?: number }) {
  const [all, setAll] = useState(false)
  const header = !prepared ? 'Not prepared yet'
    : `Prepared for: ${[prepared.meetingTitle, prepared.focus].filter(Boolean).join(' · ') || 'the next call'}`
  const sorted = [...bullets].sort((a, b) => b.at - a.at)
  const shown = all ? sorted : sorted.slice(0, BULLETS_OPEN)
  const folded = sorted.length - shown.length
  return <section data-testid="ole-bullets" className="ole-bullets flex flex-col gap-2" aria-label="Context">
    <p data-testid="ole-bullets-header" className="widget-preview-speaker" title={header}>{header}</p>
    {!sorted.length ? <p className="widget-preview-empty">Context will appear here as the call goes.</p>
      : <div data-testid="ole-bullets-scroll" style={{ maxHeight, overflowY: 'auto' }}>
        <ul role="list" className="flex flex-col gap-1">
          {/* a bullet from the last few seconds has a green edge, so what just changed stands out */}
          {shown.map(b => <li key={b.id} data-testid="ole-bullet" data-new={now - b.at < NEW_MS || undefined} className="widget-preview-bubble text-[13px] leading-[18px]" dir="auto"
            style={now - b.at < NEW_MS ? { boxShadow: 'inset 3px 0 0 #6cc463' } : undefined}>
            <span>{b.text}</span>
            {b.heard && <span data-testid="ole-bullet-heard" className="block text-[11px] leading-[16px] text-[#B8B8C0]">Heard: “{b.heard}”</span>}
            {b.quote
              ? <span data-testid="ole-bullet-source" className="block text-[11px] leading-[16px] text-[#B8B8C0]">From {b.source}: “{b.quote}”</span>
              : <span data-testid="ole-bullet-source" className="block text-[11px] leading-[16px] text-[#B8B8C0]">{b.source}</span>}
          </li>)}
        </ul>
        {(folded > 0 || all) && sorted.length > BULLETS_OPEN && <button data-testid="ole-bullets-more" className="text-action mt-1 text-[12px]" onClick={() => setAll(v => !v)}>
          {all ? 'Show fewer' : `Show ${folded} earlier`}</button>}
      </div>}
  </section>
}
