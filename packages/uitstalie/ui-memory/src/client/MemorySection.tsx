/**
 * The memory settings page: the volatile `memory` row fields, staged and saved as one mutation.
 *
 * The component is presentation only: every value arrives through the inject face, every action
 * calls the controller, and every sentence comes from the `settings.memory` dictionary.
 *
 * @module @deepseek-ai/dsh-client-ui-memory/MemorySection
 */

import { useSyncExternalStore } from 'react'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { type MemoryKey } from './locales.ts'
import { MEMORY_SETTINGS_FIELDS, type MemorySettingsController, type MemorySettingsField } from './settings.ts'
import styles from './MemorySection.module.css'

/** What the registration injects into the page. */
export interface MemorySectionInjected {
  /** The page controller (edit, discard, save). */
  controller: MemorySettingsController
  /** This page's copy (`settings.memory`). */
  t: (key: MemoryKey) => string
}

/** The page's props: the inject face, flattened, so a test may supply a subset. */
export type MemorySectionProps = Partial<InjectFace<MemorySectionInjected>>

/** Label and placeholder of one field, in the dictionary's words. */
function copyKeysOf(field: MemorySettingsField): { labelKey: MemoryKey; placeholderKey: MemoryKey } {
  switch (field) {
    case 'detail': return { labelKey: 'fieldDetail', placeholderKey: 'placeholderInherit' }
    case 'brief': return { labelKey: 'fieldBrief', placeholderKey: 'placeholderInherit' }
    case 'forget': return { labelKey: 'fieldForget', placeholderKey: 'placeholderInherit' }
    case 'sessions': return { labelKey: 'fieldSessions', placeholderKey: 'placeholderInherit' }
    case 'maxBytes': return { labelKey: 'fieldMaxBytes', placeholderKey: 'placeholderInherit' }
    case 'summarizationProvider': return { labelKey: 'fieldProvider', placeholderKey: 'placeholderInherit' }
    case 'summarizationModel': return { labelKey: 'fieldModel', placeholderKey: 'placeholderModel' }
  }
}

/** Whether one field takes a number. */
const NUMERIC = new Set<MemorySettingsField>(['detail', 'brief', 'forget', 'sessions', 'maxBytes'])

/** The memory settings page. */
export function MemorySection(props: MemorySectionProps) {
  const { controller, t } = props
  // The assembly guarantees the page face; the partial props are the test path that supplies it.
  if (controller === undefined || t === undefined) return null
  const state = useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot)

  if (!state.available) return <p className={styles.notice}>{t('unavailable')}</p>
  return (
    <div className={styles.section}>
      <h2 className={styles.title}>{t('title')}</h2>
      <p className={styles.intro}>{t('intro')}</p>
      <div className={styles.fields}>
        {MEMORY_SETTINGS_FIELDS.map((field) => {
          const copy = copyKeysOf(field)
          const invalid = state.invalid.includes(field)
          return (
            <label key={field} className={styles.field}>
              <span className={styles.label}>{t(copy.labelKey)}</span>
              <input
                className={styles.input}
                value={state.values[field]}
                inputMode={NUMERIC.has(field) ? 'numeric' : undefined}
                placeholder={t(copy.placeholderKey)}
                aria-invalid={invalid || undefined}
                onChange={(event) => { controller.edit(field, event.target.value) }}
              />
              {invalid ? <span className={styles.invalid} role="alert">{t('invalidField')}</span> : null}
            </label>
          )
        })}
      </div>
      <p className={styles.notice}>{t('staleNote')}</p>
      <div className={styles.actions}>
        <Button
          variant="outline"
          size="sm"
          disabled={!state.dirty || state.saving || state.invalid.length > 0 || !state.writable}
          onClick={() => { void controller.save() }}
        >
          {state.saving ? t('saving') : t('save')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!state.dirty || state.saving}
          onClick={() => { controller.discard() }}
        >
          {t('discard')}
        </Button>
      </div>
      {state.failed ? <p className={styles.error} role="alert">{t('saveFailed')}</p> : null}
    </div>
  )
}
