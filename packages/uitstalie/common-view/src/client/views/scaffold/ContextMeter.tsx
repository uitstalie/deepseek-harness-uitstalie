/**
 * The composer's context-occupancy meter, replicated from the conversation
 * view's own bar: the ring and percentage that open a panel breaking the
 * occupancy down by system prompt, tool definitions, and messages.
 *
 * Measurements and geometry come from `ui-conversation`'s
 * `ContextMeter.tsx` / `ContextMeter.module.css`; the panel is anchored and
 * dismissed through the shared primitives, as the shell does.
 * @module @deepseek-ai/dsh-client-common-view/ContextMeter
 */
import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Tooltip, useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import { classes } from './classes.ts'
import css from './ContextMeter.module.css'
import type { CommonViewKey } from '../../locales.ts'

/** Ring geometry: a 14px viewBox with a 2px stroke. */
const RADIUS = 5.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/** Marker the occupancy sentence is split on, so each locale keeps its word order. */
const READING_SLOT = '\u0000'

/** The occupancy the meter reports. */
export interface ContextOccupancy {
  /** Provider-exact share of the window in use, as a whole percent. */
  percent: number
  /** Tokens the providers project as used. */
  usedTokens: number
  /** The route's context window. */
  contextWindow: number
  /** Heuristic split of the occupancy, in tokens. */
  breakdown: {
    systemTokens: number
    toolsTokens: number
    messageTokens: number
  }
}

/** Injected share of the meter. */
export interface ContextMeterInjected {
  /** Localized copy of the `common-view` namespace. */
  t: (key: CommonViewKey, params?: Record<string, string>) => string
  /** What the meter reports. */
  occupancy: ContextOccupancy
}

/** Props the meter renders from. */
export type ContextMeterProps = ContextMeterInjected

/** Panel legend rows in bar-segment order, each carrying its own tint class. */
const ROWS = [
  { key: 'systemTokens', label: 'scaffold.contextSystem', color: css.colorSystem },
  { key: 'toolsTokens', label: 'scaffold.contextTools', color: css.colorTools },
  { key: 'messageTokens', label: 'scaffold.contextMessages', color: css.colorMessages },
] as const satisfies readonly { key: keyof ContextOccupancy['breakdown']; label: CommonViewKey; color: string | undefined }[]

/**
 * Format a token count the way the compact panel does.
 * @param value - token count.
 * @param t - the copy namespace.
 * @returns the localized compact count.
 */
function formatTokens(value: number, t: ContextMeterInjected['t']): string {
  const scaled = (candidate: number): string => candidate >= 100
    ? String(Math.round(candidate))
    : String(Math.round(candidate * 10) / 10)
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return t('scaffold.numberThousand', { value: scaled(value / 1_000) })
  return t('scaffold.numberMillion', { value: scaled(value / 1_000_000) })
}

/**
 * Render the meter and, while open, its breakdown panel.
 * @param props - the copy namespace and the occupancy to report.
 * @returns the meter pill and its portaled panel.
 */
export function ContextMeter({ t, occupancy }: ContextMeterProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const position = useAnchoredPosition({ open, anchorRef: rootRef, panelRef, side: 'top', gap: 8, margin: 12 })
  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)

  const reading = `${String(occupancy.percent)}%`
  const [headBefore = '', headAfter = ''] = t('scaffold.contextAria', { percent: READING_SLOT })
    .split(READING_SLOT)
    .map(part => part.trim())
  const breakdownTotal = ROWS.reduce((total, row) => total + occupancy.breakdown[row.key], 0)
  // The bar's length stays the provider-exact percent; the heuristic breakdown
  // only proportions its parts, and a zero-width part would draw a filled bar.
  const segments = breakdownTotal === 0
    ? [{ key: 'total', color: undefined, width: occupancy.percent }]
    : ROWS
      .map(row => ({
        key: row.key,
        color: row.color,
        width: occupancy.percent * occupancy.breakdown[row.key] / breakdownTotal,
      }))
      .filter(segment => segment.width > 0)

  return (
    <span ref={rootRef} className={css.root}>
      <Tooltip label={t('scaffold.contextAria', { percent: reading })} side="top" delayMs={200} disabled={open}>
        <button
          type="button"
          className={css.trigger}
          aria-label={t('scaffold.contextAria', { percent: reading })}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => { setOpen(current => !current) }}
        >
          <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden>
            <circle className={css.track} cx="7" cy="7" r={RADIUS} />
            <circle
              className={css.fill}
              cx="7"
              cy="7"
              r={RADIUS}
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={CIRCUMFERENCE * (1 - occupancy.percent / 100)}
              transform="rotate(-90 7 7)"
            />
          </svg>
          <span>{reading}</span>
        </button>
      </Tooltip>
      {open && createPortal(
        <div
          ref={panelRef}
          className={css.panel}
          style={position ?? { visibility: 'hidden', left: 0, top: 0 }}
          role="dialog"
          aria-label={t('scaffold.contextUsed')}
        >
          <div className={css.header}>
            {/* Empty sides collapse so the locale needing no leading text spends no gap. */}
            <span className={css.headline}>{headBefore}</span>
            <span className={css.percent}>{reading}</span>
            <span className={css.headline}>{headAfter}</span>
            <span className={css.figures}>
              {`~${formatTokens(occupancy.usedTokens, t)} / ${formatTokens(occupancy.contextWindow, t)}`}
            </span>
          </div>
          <div className={css.bar}>
            {segments.map(segment => (
              <div
                key={segment.key}
                className={segment.color === undefined ? css.segment : classes(css.segment, segment.color)}
                style={{ width: `${String(segment.width)}%` }}
              />
            ))}
          </div>
          <dl className={css.rows}>
            {ROWS.map(row => (
              <div key={row.key} className={css.row}>
                <dt>
                  <span className={classes(css.swatch, row.color)} aria-hidden />
                  {t(row.label)}
                </dt>
                <dd>{`~${formatTokens(occupancy.breakdown[row.key], t)}`}</dd>
              </div>
            ))}
          </dl>
        </div>,
        document.body,
      )}
    </span>
  )
}
