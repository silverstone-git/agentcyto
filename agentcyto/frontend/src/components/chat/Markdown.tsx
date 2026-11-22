import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'

// Models often emit \( \) and \[ \] delimiters; remark-math wants $ and $$.
function normalizeMath(src: string): string {
  let t = src
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => `$$${m}$$`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => `$${m}$`)
  // An odd number of $$ means the model left one dangling (or we are mid-stream): drop the last.
  const marks = t.match(/\$\$/g)?.length ?? 0
  if (marks % 2 === 1) {
    const i = t.lastIndexOf('$$')
    t = t.slice(0, i) + t.slice(i + 2)
  }
  // Split into $$…$$ blocks and prose; make blocks real display math, and wrap bare \begin{…}…\end{…}.
  return t
    .split(/(\$\$[\s\S]*?\$\$)/g)
    .map((part, i) => {
      if (i % 2 === 1) return `\n\n$$\n${part.slice(2, -2).trim()}\n$$\n\n`
      return part.replace(/\\begin\{([a-zA-Z*]+)\}[\s\S]*?\\end\{\1\}/g, (m) => `\n\n$$\n${m}\n$$\n\n`)
    })
    .join('')
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
