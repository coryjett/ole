// Ole: the live context bullets shown in the floating widget, newest first, each with its source.
import type { OleBullet } from '../../../main/ole/types'

export type OlePrepared = { meetingTitle: string | null; focus: string | null }

export function OleBullets({ bullets, prepared }: { bullets: OleBullet[]; prepared: OlePrepared | null }) {
  const header = !prepared ? 'Not prepared yet'
    : `Prepared for: ${[prepared.meetingTitle, prepared.focus].filter(Boolean).join(' · ') || 'the next call'}`
  const sorted = [...bullets].sort((a, b) => b.at - a.at)
  return <section data-testid="ole-bullets" className="ole-bullets flex flex-col gap-2" aria-label="Context">
    <p data-testid="ole-bullets-header" className="widget-preview-speaker" title={header}>{header}</p>
    {!sorted.length ? <p className="widget-preview-empty">Context will appear here as the call goes.</p>
      : <ul role="list" className="flex flex-col gap-1">
        {sorted.map(b => <li key={b.id} data-testid="ole-bullet" className="widget-preview-bubble text-[13px] leading-[18px]" dir="auto">
          <span>{b.text}</span>
          <span data-testid="ole-bullet-source" className="block text-[11px] leading-[16px] text-[#B8B8C0]">{b.source}</span>
        </li>)}
      </ul>}
  </section>
}
