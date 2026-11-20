// Ole: the live context bullets, newest first, each with its source. The list has a fixed height and scrolls, and only
// the newest few are open; older ones fold behind "Show N earlier", so a long call never pushes the notes away (#38).
import { useState } from 'react'
import type { OleBullet } from '../../../main/ole/core/types'
import { httpsHref, shownSource } from '../../../main/ole/core/links'
import { spotlight as split } from '../../../main/ole/core/spotlight'

export type OlePrepared = { meetingTitle: string | null; focus: string | null }

/** bullets shown before the rest fold away */
export const BULLETS_OPEN = 4
/** how long a new bullet stays highlighted */
export const NEW_MS = 8000

/**
 * The source, as a link when Ole has a verified one (#42); links open in the browser. The label is cleaned and capped
 * by the core's own functions (#102, #107, #111), and the link is checked again here: https only.
 */
export function SourceName({ b }: { b: Pick<OleBullet, 'source' | 'url'> }) {
  const label = shownSource(b.source)
  const href = httpsHref(b.url)
  return href ? <a data-testid="ole-bullet-link" href={href} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline', color: 'inherit' }}>{label}</a> : <>{label}</>
}

/** pin (#54) and thumbs (#55): small text buttons that say when they are on */
function BulletControls({ b, onPin, onRate, onNote }: { b: OleBullet; onPin: (id: string, on: boolean) => void; onRate: (id: string, r: 'up' | 'down' | null) => void
  /** open the note input (#174) */
  onNote?: () => void }) {
  const btn = (on: boolean) => `text-[12px] leading-none ${on ? 'opacity-100' : 'opacity-50 hover:opacity-90'}`
  return <span className="ml-2 inline-flex gap-2 align-middle">
    <button data-testid="ole-bullet-pin" aria-pressed={!!b.pinned} title={b.pinned ? 'Unpin' : 'Pin: keep it in the notes and summary'} className={btn(!!b.pinned)} onClick={() => onPin(b.id, !b.pinned)}>📌</button>
    <button data-testid="ole-bullet-up" aria-pressed={b.rating === 'up'} title="Useful" className={btn(b.rating === 'up')} onClick={() => onRate(b.id, b.rating === 'up' ? null : 'up')}>👍</button>
    <button data-testid="ole-bullet-down" aria-pressed={b.rating === 'down'} title="Not useful: nothing more on this topic this call, and fewer like it later" className={btn(b.rating === 'down')} onClick={() => onRate(b.id, b.rating === 'down' ? null : 'down')}>👎</button>
    {onNote && <button data-testid="ole-bullet-note" title="Add a note: it goes into My notes and steers Ole" aria-label="Add a note" className={btn(!!b.note)} onClick={onNote}>📝</button>}
  </span>
}

export function OleBullets({ bullets, prepared, maxHeight = 320, now = Date.now(), onPin, onRate, onNote, header: showHeader = true, spotlight = false }: { bullets: OleBullet[]; prepared: OlePrepared | null; /** live call only: a note on a bullet (#174) */ onNote?: (b: OleBullet, text: string) => void; /** the Live tab (#172): act bullets as Right now cards, the rest folded under Earlier */ spotlight?: boolean; /** the "Prepared for" line; the Live tab says who the briefing is for instead (#138, #140) */ header?: boolean; /** 'none': no cap, the page around it scrolls (the note's Live tab, #108) */
  maxHeight?: number | 'none'; now?: number
  /** live call only: pin (#54) and rate (#55); a saved meeting shows the marks without buttons */
  onPin?: (id: string, on: boolean) => void; onRate?: (id: string, r: 'up' | 'down' | null) => void }) {
  const [all, setAll] = useState(false)
  const [noting, setNoting] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const saveNote = (b: OleBullet) => { const t = draft.trim(); if (t) onNote?.(b, t); setNoting(null); setDraft('') }
  const header = !prepared ? 'Not prepared yet'
    : `Prepared for: ${[prepared.meetingTitle, prepared.focus].filter(Boolean).join(' · ') || 'the next call'}`
  const item = (b: OleBullet, o: { className?: string; quiet?: boolean } = {}) => <li key={b.id} data-testid="ole-bullet" data-new={now - b.at < NEW_MS || undefined} className={o.className ?? 'widget-preview-bubble text-[13px] leading-[18px]'} dir="auto"
    style={{ ...(now - b.at < NEW_MS && !o.className ? { boxShadow: 'inset 3px 0 0 #6cc463' } : {}), ...(o.quiet ? { opacity: 0.7 } : {}) }}>
    <span>{b.pinned && !onPin && <span data-testid="ole-bullet-pinned" title="Pinned">📌 </span>}{b.text}</span>
    {onPin && onRate && <BulletControls b={b} onPin={onPin} onRate={onRate} onNote={onNote ? () => { setNoting(b.id); setDraft(b.note ?? '') } : undefined} />}
    {b.note && noting !== b.id && <span data-testid="ole-bullet-your-note" className="block text-[12px] leading-[17px]">📝 {b.note}</span>}
    {noting === b.id && <input data-testid="ole-bullet-note-input" autoFocus className="settings-input mt-1 w-full text-[12px]" maxLength={200} placeholder="Your note: Enter to save, Esc to cancel"
      aria-label="Note on this bullet" value={draft} onChange={e => setDraft(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); saveNote(b) } else if (e.key === 'Escape') { e.preventDefault(); setNoting(null); setDraft('') } }} />}
    {b.heard && <span data-testid="ole-bullet-heard" className="block text-[11px] leading-[16px] text-[#B8B8C0]">Heard: “{b.heard}”</span>}
    {b.quote
      ? <span data-testid="ole-bullet-source" className="block text-[11px] leading-[16px] text-[#B8B8C0]">From <SourceName b={b} />: “{b.quote}”</span>
      : <span data-testid="ole-bullet-source" className="block text-[11px] leading-[16px] text-[#B8B8C0]"><SourceName b={b} /></span>}
  </li>
  if (spotlight && bullets.length) {
    // the Live tab (#172): what changes what you say next, loud; the rest one click away, quiet
    const { now: loud, earlier } = split(bullets)
    return <section data-testid="ole-bullets" className="ole-bullets flex flex-col gap-3" aria-label="Context">
      <div data-testid="ole-now">
        <p className="mb-1.5 text-[11px] font-semibold uppercase leading-[16px] tracking-wide" style={{ color: 'var(--accent)' }}>Right now</p>
        {loud.length ? <ul role="list" className="flex flex-col gap-2">{loud.map(b => item(b, { className: 'ole-now-card' }))}</ul>
          : <p className="text-[13px]" style={{ color: 'var(--muted)' }}>Nothing that needs you yet.</p>}
      </div>
      {earlier.length > 0 && <div data-testid="ole-earlier">
        <button data-testid="ole-earlier-toggle" className="text-action text-[12px]" aria-expanded={all} onClick={() => setAll(v => !v)}>{all ? 'Hide earlier' : `Earlier (${earlier.length})`}</button>
        {all && <ul role="list" className="mt-1 flex flex-col gap-1">{earlier.map(b => item(b, { className: 'widget-preview-bubble text-[12px] leading-[17px]', quiet: true }))}</ul>}
      </div>}
    </section>
  }
  const sorted = [...bullets].sort((a, b) => b.at - a.at)
  const shown = all ? sorted : sorted.slice(0, BULLETS_OPEN)
  const folded = sorted.length - shown.length
  return <section data-testid="ole-bullets" className="ole-bullets flex flex-col gap-2" aria-label="Context">
    {showHeader && <p data-testid="ole-bullets-header" className="widget-preview-speaker" title={header}>{header}</p>}
    {!sorted.length ? <p className="widget-preview-empty">Context will appear here as the call goes.</p>
      : <div data-testid="ole-bullets-scroll" style={{ maxHeight, overflowY: 'auto' }}>
        <ul role="list" className="flex flex-col gap-1">
          {/* a bullet from the last few seconds has a green edge, so what just changed stands out */}
          {shown.map(b => item(b))}
        </ul>
        {(folded > 0 || all) && sorted.length > BULLETS_OPEN && <button data-testid="ole-bullets-more" className="text-action mt-1 text-[12px]" onClick={() => setAll(v => !v)}>
          {all ? 'Show fewer' : `Show ${folded} earlier`}</button>}
      </div>}
  </section>
}
