/**
 * The generic tool card, replicated from the tool package's own summary row and
 * its disclosure: a 24px line of `[16 leading] gap6 [title 13/24] gap8 [2x2 dot]
 * gap8 [summary, truncating]` that expands into the tool's output.
 *
 * The row chrome and the output block are the shared primitives the shell itself
 * composes (`DisclosureRow`, `CodeBlock`); this module carries only the shell's
 * own row measurements from `ui-tool`'s `ToolRow.module.css`.
 *
 * The per-tool leading glyphs, diff/read/search bodies, and the visually hidden
 * status sentence are separate slices.
 * @module @deepseek-ai/dsh-client-common-view/ToolCard
 */
import { useState } from 'react'
import { CodeBlock, DisclosureRow } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './ToolCard.module.css'
import type { CommonViewKey } from '../../locales.ts'

/** One tool call as the transcript draws it. */
export interface ToolCardModel {
  /** Stable identity of the call. */
  id: string
  /** Tool name, shown as the row title. */
  name: string
  /** One-line summary of the call's arguments. */
  summary: string
  /** The call's output, shown while expanded. */
  output: string
  /** Grammar of the output, when it has one. */
  lang?: string | undefined
  /** Whether the call is still running, which animates the row. */
  running?: boolean | undefined
}

/** Injected share of the card. */
export interface ToolCardInjected {
  /** Localized copy of the `common-view` namespace. */
  t: (key: CommonViewKey, params?: Record<string, string>) => string
  /** The call to draw. */
  tool: ToolCardModel
}

/** Props the card renders from. */
export type ToolCardProps = ToolCardInjected

/**
 * Render one tool call.
 * @param props - the copy namespace and the call.
 * @returns the disclosure row and, while open, its output.
 */
export function ToolCard({ t, tool }: ToolCardProps) {
  // Component-private: only this card reads its disclosure state.
  const [open, setOpen] = useState(false)
  return (
    <div className={css.root}>
      <DisclosureRow
        icon={<span className={css.leadingGlyph} aria-hidden />}
        title={tool.name}
        running={tool.running === true}
        open={open}
        expandable
        expandOnRowClick
        keepContentWhenOpen
        onToggle={() => { setOpen(current => !current) }}
        leadingClassName={css.leading}
        titleClassName={css.title}
        collapsedContent={(
          <>
            {/* An empty summary drops the separator with it. */}
            <span className={css.sep} aria-hidden />
            <span className={css.summary}>{tool.summary}</span>
          </>
        )}
      >
        <CodeBlock
          code={tool.output}
          lang={tool.lang}
          copyLabel={t('scaffold.copy')}
          copiedLabel={t('scaffold.copied')}
        />
      </DisclosureRow>
    </div>
  )
}
