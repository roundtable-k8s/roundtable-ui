import ReactMarkdown from 'react-markdown'
import { safeUrl, sanitizeText } from '../lib/untrusted'

/**
 * Markdown with raw HTML disabled (no rehype-raw; react-markdown escapes HTML
 * by default) and an http/https link allowlist. Images are not rendered (#188).
 */
export function SafeMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      skipHtml
      urlTransform={(url: string) => safeUrl(url)}
      components={{
        a: ({ href, children: c }: { href?: string; children?: React.ReactNode }) => {
          const h = safeUrl(href)
          return h ? <a href={h} target="_blank" rel="noopener noreferrer nofollow">{c}</a> : <span>{c}</span>
        },
        img: ({ alt }: { alt?: string }) => <span>{alt ?? ''}</span>,
      }}
    >
      {sanitizeText(children)}
    </ReactMarkdown>
  )
}
