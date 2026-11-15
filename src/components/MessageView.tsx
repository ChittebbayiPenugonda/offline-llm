import { memo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { Message } from '../types'

function CodeBlock(props: any) {
  const [copied, setCopied] = useState(false)
  const text = extractText(props.children)
  return (
    <div className="codeblock">
      <button
        className="copy-code"
        onClick={() => {
          navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre {...props} />
    </div>
  )
}

function extractText(node: any): string {
  if (node == null) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(extractText).join('')
  return extractText(node.props?.children)
}

const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={{ pre: CodeBlock }}>
      {text}
    </ReactMarkdown>
  )
})

export function MessageView({
  message,
  streaming,
  onRegenerate,
}: {
  message: Message
  streaming: boolean
  onRegenerate?: () => void
}) {
  const [copied, setCopied] = useState(false)

  if (message.role === 'user') {
    return (
      <div className="msg user">
        <div className="bubble">
          {message.images?.length ? (
            <div className="msg-images">
              {message.images.map((src, i) => (
                <img key={i} src={src} alt="" />
              ))}
            </div>
          ) : null}
          {message.content && <div className="user-text">{message.content}</div>}
        </div>
      </div>
    )
  }

  const thinking = streaming && !message.content && !!message.reasoning
  return (
    <div className="msg assistant">
      {message.reasoning ? (
        <details className="thinking" open={thinking}>
          <summary>{thinking ? 'Thinking…' : 'Thought process'}</summary>
          <div className="thinking-body">
            <Markdown text={message.reasoning} />
          </div>
        </details>
      ) : null}
      <div className="prose">
        {message.content ? <Markdown text={message.content} /> : null}
        {streaming && !message.content && !message.reasoning ? <span className="dots"><i /><i /><i /></span> : null}
        {streaming && message.content ? <span className="caret" /> : null}
      </div>
      {message.error ? <div className="msg-error">⚠ {message.error}</div> : null}
      {!streaming && (
        <div className="msg-actions">
          <button
            onClick={() => {
              navigator.clipboard.writeText(message.content)
              setCopied(true)
              setTimeout(() => setCopied(false), 1200)
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          {onRegenerate && <button onClick={onRegenerate}>Retry</button>}
          {message.stats && (
            <span className="stats" title="Measured in your browser from the token stream">
              {message.stats.tokensPerSec.toFixed(1)} tok/s · {message.stats.approx ? '~' : ''}
              {message.stats.tokens} tokens · {(message.stats.ttftMs / 1000).toFixed(2)}s to first token
            </span>
          )}
          {message.model && <span className="stats model-tag">{message.model}</span>}
        </div>
      )}
    </div>
  )
}
