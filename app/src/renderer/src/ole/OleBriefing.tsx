// Ole: the briefing Prepare wrote, readable on Home, from the first second of a call, and on the saved meeting (#35).
// A small markdown reader (headings, bullets, bold) rather than a dependency: the briefing is plain model output.
import { useState, type ReactNode } from 'react'

/** bold, markdown links (https only, opened in the browser) and plain text (#42) */
const inline = (text: string): ReactNode[] => text.split(/(\*\*[^*]+\*\*|\[[^\]]+\]\(https:\/\/[^)\s]+\))/g).map((part, i) => {
  if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={i}>{part.slice(2, -2)}</strong>
  const link = part.match(/^\[([^\]]+)\]\((https:\/\/[^)\s]+)\)$/)
  if (link) return <a key={i} href={link[2]} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>{link[1]}</a>
  return <span key={i}>{part.replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1$2')}</span>
})

export function BriefingText({ text }: { text: string }) {
  const lines = text.split('\n')
  return <div data-testid="ole-briefing-text" className="text-[13px] leading-[19px]" dir="auto">
    {lines.map((raw, i) => {
      const line = raw.trimEnd()
      if (!line.trim()) return <div key={i} style={{ height: 6 }} />
      const h = line.match(/^#{1,6}\s+(.*)$/)
      if (h) return <p key={i} className="mt-2 font-semibold">{inline(h[1])}</p>
      const li = line.match(/^\s*[-*•]\s+(.*)$/)
      if (li) return <p key={i} style={{ paddingLeft: 14, textIndent: -10 }}>• {inline(li[1])}</p>
      return <p key={i}>{inline(line)}</p>
    })}
  </div>
}

/** collapsible; open by default when there is nothing else to read yet */
export function OleBriefing({ text, defaultOpen, maxHeight = 360 }: { text: string; defaultOpen: boolean; /** 'none': no cap, the page around it scrolls (the note's Briefing tab, #108) */ maxHeight?: number | 'none' }) {
  const [open, setOpen] = useState(defaultOpen)
  const [copied, setCopied] = useState(false)
  if (!text.trim()) return null
  const copy = () => { void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }, () => {}) }
  return <section data-testid="ole-briefing" aria-label="Briefing" className="mt-2">
    <div className="flex items-center gap-2">
      <button data-testid="ole-briefing-toggle" className="text-[13px] font-semibold" aria-expanded={open} onClick={() => setOpen(v => !v)}>{open ? '▾' : '▸'} Briefing</button>
      {open && <button data-testid="ole-briefing-copy" className="text-action text-[12px]" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>}
    </div>
    {open && <div style={{ maxHeight, overflowY: 'auto', marginTop: 6 }}><BriefingText text={text} /></div>}
  </section>
}

/** the briefing's "Before you join" items (#46), for the strip pinned above the live bullets (#49) */
export function beforeYouJoin(text: string, max = 3): string[] {
  const lines = text.split('\n')
  const start = lines.findIndex(l => /^#{1,6}\s*before you join\b/i.test(l.trim()))
  if (start === -1) return []
  const out: string[] = []
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim()
    if (/^#{1,6}\s/.test(line)) break
    const li = line.match(/^[-*•]\s+(.*)$/)
    if (li) out.push(li[1])
    if (out.length === max) break
  }
  return out
}

/** the pinned strip: the few things that matter most, always in view during the call */
export function BeforeYouJoinStrip({ text }: { text: string }) {
  const items = beforeYouJoin(text)
  if (!items.length) return null
  return <div data-testid="ole-before-strip" className="mb-2 rounded-lg px-3 py-2 text-[12px] leading-[17px]" style={{ background: 'rgba(108, 196, 99, 0.10)', boxShadow: 'inset 3px 0 0 #6cc463' }}>
    {items.map((it, i) => <p key={i} dir="auto">• {inline(it)}</p>)}
  </div>
}
