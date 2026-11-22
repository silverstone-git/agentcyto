import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'

// Models often emit \( \) and \[ \] delimiters; remark-math wants $ and $$.
function normalizeMath(src: string): string {
  return src
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => `\n$$\n${m}\n$$\n`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => `$${m}$`)
}

// Turn [3] / [1][2] / [1, 2] into links we can style and intercept.
function linkCitations(src: string, max: number): string {
  if (!max) return src
  return src.replace(/\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\](?!\()/g, (full, nums: string) => {
    const ns = nums.split(',').map((n) => parseInt(n.trim(), 10))
    if (ns.some((n) => n < 1 || n > max)) return full
    return ns.map((n) => `[${n}](#cite-${n})`).join(' ')
  })
}

export default function Markdown({
  text,
  citations = 0,
  onCite,
}: {
  text: string
  citations?: number
  onCite?: (n: number) => void
}) {
  const src = linkCitations(normalizeMath(text), citations)
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
        components={{
          a({ href, children }) {
            const m = href?.match(/^#cite-(\d+)$/)
            if (m) {
              const n = parseInt(m[1], 10)
              return (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onCite?.(n) }}
                  className="cite-chip"
                  title={`Open source passage ${n}`}
                >
                  {n}
                </button>
              )
            }
            return <a href={href} target="_blank" rel="noreferrer">{children}</a>
          },
        }}
      >
        {src}
      </ReactMarkdown>
    </div>
  )
}
