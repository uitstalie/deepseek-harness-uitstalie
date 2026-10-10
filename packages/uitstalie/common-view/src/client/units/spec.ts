/**
 * The composition layer's unit vocabulary, and the single place that turns a
 * unit spec back into what DSH renders natively: a box whose class comes from
 * the unit's own CSS module, whose gap travels as a component-local custom
 * property, and whose two axes are discrete inline values.
 *
 * Composition happens here; nothing foreign reaches the DOM: the unit's
 * geometry becomes a component-local custom property plus two inline axes, and
 * its box class comes from the unit's own CSS module.
 * @module @deepseek-ai/dsh-client-common-view/units/spec
 */
import type { CSSProperties } from 'react'
import rowCss from './Row.module.css'
import columnCss from './Column.module.css'

/** Unit kinds the composition layer can emit. */
export type UnitKind = 'row' | 'column'

/** Cross-axis placement of a unit's children. */
export type UnitAlign = 'start' | 'center' | 'end' | 'stretch'

/** Along-axis distribution of a unit's children. */
export type UnitJustify = 'start' | 'center' | 'end' | 'between'

/** One unit of a composed view; pure data, resolved then emitted. */
export interface UnitSpec {
  /** Which axis the unit lays its children out along. */
  kind: UnitKind
  /** Gap between children, as a CSS length. */
  gap?: string | undefined
  /** Cross-axis placement. */
  align?: UnitAlign | undefined
  /** Along-axis distribution. */
  justify?: UnitJustify | undefined
}

/** The resolved fields of a unit spec. */
export interface ResolvedUnit {
  /** Gap between children. */
  gap: string
  /** Cross-axis placement. */
  align: UnitAlign
  /** Along-axis distribution. */
  justify: UnitJustify
}

/** Per-kind defaults: a row centres its children, a column stretches them. */
export const UNIT_DEFAULTS: Readonly<Record<UnitKind, ResolvedUnit>> = {
  row: { gap: '4px', align: 'center', justify: 'start' },
  column: { gap: '4px', align: 'stretch', justify: 'start' },
}

/**
 * Resolve a unit spec into complete values.
 * @param spec - the unit as composed.
 * @returns every field, defaulted per {@link UNIT_DEFAULTS}.
 */
export function resolveUnit(spec: UnitSpec): ResolvedUnit {
  const defaults = UNIT_DEFAULTS[spec.kind]
  return {
    gap: spec.gap ?? defaults.gap,
    align: spec.align ?? defaults.align,
    justify: spec.justify ?? defaults.justify,
  }
}

/**
 * Emit the native box for a resolved unit: the unit's own class plus inline
 * custom properties and axes, and nothing else.
 * @param spec - the unit as composed.
 * @param className - an optional extra class the composing caller owns.
 * @returns the class name and inline style DSH renders.
 */
export function emitUnit(
  spec: UnitSpec,
  className?: string,
  style?: CSSProperties,
): { className: string; style: CSSProperties } {
  const resolved = resolveUnit(spec)
  const kindClass = spec.kind === 'row' ? rowCss.row : columnCss.column
  return {
    className: [kindClass, className].filter((part): part is string => part !== undefined).join(' '),
    style: {
      '--dsh-common-view-unit-gap': resolved.gap,
      alignItems: resolved.align === 'start' ? 'flex-start' : resolved.align === 'end' ? 'flex-end' : resolved.align,
      justifyContent: resolved.justify === 'between'
        ? 'space-between'
        : resolved.justify === 'start'
          ? 'flex-start'
          : resolved.justify === 'end'
            ? 'flex-end'
            : resolved.justify,
      ...style,
    } as CSSProperties,
  }
}
