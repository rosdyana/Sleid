// Renders a comment's markup as React nodes. Nothing here is HTML: text stays text, and a mention is a chip.
import { Fragment, useMemo } from 'react'
import { parseCommentBody, type CommentInline } from '@sleid/model'

export function CommentBody({ body }: { body: string }) {
  const lines = useMemo(() => parseCommentBody(body), [body])
  return (
    <div className="space-y-1 break-words text-[13px] leading-snug">
      {lines.map((line, i) => (
        <p key={i} className="min-h-[1em] whitespace-pre-wrap">
          {line.map((node, j) => (
            <Fragment key={j}>{renderNode(node)}</Fragment>
          ))}
        </p>
      ))}
    </div>
  )
}

function renderNode(node: CommentInline) {
  switch (node.kind) {
    case 'text':
      return node.text
    case 'mention':
      return (
        <span data-testid="comment-mention" data-user-id={node.userId} className="rounded bg-accent/10 px-1 font-medium text-accent">
          @{node.name}
        </span>
      )
    case 'strong':
      return <strong className="font-semibold">{node.text}</strong>
    case 'em':
      return <em>{node.text}</em>
    case 'code':
      return <code className="rounded bg-hover px-1 font-mono text-[12px]">{node.text}</code>
  }
}
