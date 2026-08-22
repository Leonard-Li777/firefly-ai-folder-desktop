import React from 'react'

export const MarkdownComponents = {
  h1: ({ children }: any) => (
    <h1 className="text-base font-bold my-2 text-foreground">{children}</h1>
  ),
  h2: ({ children }: any) => (
    <h2 className="text-sm font-bold my-1.5 text-foreground">{children}</h2>
  ),
  h3: ({ children }: any) => <h3 className="text-xs font-bold my-1 text-foreground">{children}</h3>,
  p: ({ children }: any) => (
    <p className="mb-2 text-sm leading-relaxed last:mb-0 whitespace-pre-line">{children}</p>
  ),
  ul: ({ children }: any) => (
    <ul className="list-disc pl-5 space-y-1 mb-2 last:mb-0">{children}</ul>
  ),
  ol: ({ children }: any) => (
    <ol className="list-decimal pl-5 space-y-1 mb-2 last:mb-0">{children}</ol>
  ),
  li: ({ children }: any) => <li className="text-sm">{children}</li>,
  strong: ({ children }: any) => <strong className="font-bold text-foreground">{children}</strong>,
  code: ({ children }: any) => (
    <code className="bg-muted px-1.5 py-0.5 rounded text-[11px] font-mono">{children}</code>
  )
}
