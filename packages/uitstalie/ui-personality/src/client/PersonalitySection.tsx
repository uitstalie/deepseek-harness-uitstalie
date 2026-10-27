/**
 * The identity proposal queue's settings page: every queued proposal with its
 * status, evidence, and the accept/reject decision.
 *
 * The component is presentation only: facts arrive through the inject face,
 * every decision calls the controller, and every sentence comes from the
 * `settings.personality` dictionary.
 *
 * @module @deepseek-ai/dsh-client-ui-personality/PersonalitySection
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import type { PersonalityProposalWire } from '@deepseek-ai/dsh-personality/types'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import { fill, type PersonalityKey } from './locales.ts'
import type {
  PersonalitySettingsController,
  PersonalitySettingsField,
} from './settings-form.ts'
import styles from './PersonalitySection.module.css'

/** The page's host-facing operations (the `remote.personality` namespace). */
export interface PersonalityProposalController {
  /** List the queue, pending first. */
  list(): Promise<readonly PersonalityProposalWire[]>
  /** Accept or reject one pending proposal and return its updated state. */
  decide(id: string, decision: 'accept' | 'reject'): Promise<PersonalityProposalWire>
}

/** What the registration injects into the page. */
export interface PersonalitySectionInjected {
  /** The proposal controller. */
  controller: PersonalityProposalController
  /** The provider-settings controller (the row's volatile fields). */
  settings: PersonalitySettingsController
  /** This page's copy (`settings.personality`). */
  t: (key: PersonalityKey) => string
}

/** The page's props: the inject face plus the shell's section affordances. */
export type PersonalitySectionProps = Partial<InjectFace<PersonalitySectionInjected>>

/** The staged field's label key. */
function labelKeyOf(field: PersonalitySettingsField): PersonalityKey {
  switch (field) {
    case 'workspaceOverlay': return 'fieldOverlay'
    case 'maxBytes': return 'fieldMaxBytes'
    case 'autoLearnEntries': return 'fieldAutoLearnEntries'
    case 'autoLearnBytes': return 'fieldAutoLearnBytes'
    case 'historyLimit': return 'fieldHistoryLimit'
  }
}

/** The numeric staged fields, in render order. */
const NUMERIC_FIELDS: readonly PersonalitySettingsField[] = [
  'maxBytes',
  'autoLearnEntries',
  'autoLearnBytes',
  'historyLimit',
]

/** The provider-settings block: the volatile row fields, staged and saved as one mutation. */
function ProviderSettings(props: {
  readonly controller: PersonalitySettingsController
  readonly t: (key: PersonalityKey) => string
}) {
  const { controller, t } = props
  const state = useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot)

  if (!state.available) return <p className={styles.note}>{t('settingsUnavailable')}</p>
  return (
    <div className={styles.provider}>
      <h3 className={styles.subtitle}>{t('settingsTitle')}</h3>
      <p className={styles.intro}>{t('settingsIntro')}</p>
      <label className={styles.toggle}>
        <input
          type="checkbox"
          checked={state.values.workspaceOverlay === 'on'}
          onChange={(event) => { controller.edit('workspaceOverlay', event.target.checked ? 'on' : '') }}
        />
        {t('fieldOverlay')}
      </label>
      <div className={styles.fields}>
        {NUMERIC_FIELDS.map((field) => {
          const invalid = state.invalid.includes(field)
          return (
            <label key={field} className={styles.field}>
              <span className={styles.label}>{t(labelKeyOf(field))}</span>
              <input
                className={styles.input}
                inputMode="numeric"
                value={state.values[field]}
                aria-invalid={invalid || undefined}
                aria-label={t(labelKeyOf(field))}
                onChange={(event) => { controller.edit(field, event.target.value) }}
              />
              {invalid ? <span className={styles.invalid} role="alert">{t('invalidField')}</span> : null}
            </label>
          )
        })}
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primary}
          disabled={!state.dirty || state.saving || state.invalid.length > 0 || !state.writable}
          onClick={() => { void controller.save() }}
        >
          {state.saving ? t('saving') : t('save')}
        </button>
        <button
          type="button"
          className={styles.secondary}
          disabled={!state.dirty || state.saving}
          onClick={() => { controller.discard() }}
        >
          {t('discard')}
        </button>
      </div>
      {state.failed ? <p className={styles.error} role="alert">{t('saveFailed')}</p> : null}
    </div>
  )
}

/** The badge copy key for one proposal status. */
function statusKey(status: PersonalityProposalWire['status']): PersonalityKey {
  switch (status) {
    case 'pending': return 'pending'
    case 'accepted': return 'accepted'
    case 'rejected': return 'rejected'
  }
}

/** One proposal row: name, status, text, evidence, and the pending decision. */
function ProposalRow(props: {
  readonly proposal: PersonalityProposalWire
  readonly busy: boolean
  readonly t: (key: PersonalityKey) => string
  readonly decide: (id: string, decision: 'accept' | 'reject') => void
}) {
  const { proposal, busy, t, decide } = props
  return (
    <li className={styles.item}>
      <div className={styles.head}>
        <span className={styles.name}>{proposal.name}</span>
        <span className={`${styles.badge} ${styles[proposal.status]}`}>{t(statusKey(proposal.status))}</span>
      </div>
      <p className={styles.text}>{proposal.text}</p>
      <p className={styles.meta}>{fill(t('evidence'), { evidence: proposal.evidence })}</p>
      <p className={styles.meta}>{fill(t('queuedAt'), { date: proposal.proposedAt })}</p>
      {proposal.status !== 'pending' ? null : (
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.primary}
            disabled={busy}
            aria-label={fill(t('acceptName'), { name: proposal.name })}
            onClick={() => { decide(proposal.id, 'accept') }}
          >
            {t('accept')}
          </button>
          <button
            type="button"
            className={styles.secondary}
            disabled={busy}
            aria-label={fill(t('rejectName'), { name: proposal.name })}
            onClick={() => { decide(proposal.id, 'reject') }}
          >
            {t('reject')}
          </button>
        </div>
      )}
    </li>
  )
}

/** The identity proposal queue page. */
export function PersonalitySection({ controller, t, settings }: PersonalitySectionProps) {
  const [proposals, setProposals] = useState<readonly PersonalityProposalWire[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [busyId, setBusyId] = useState<string>()

  useEffect(() => {
    if (controller === undefined) return
    let cancelled = false
    setLoading(true)
    void controller.list().then((rows) => {
      if (cancelled) return
      setProposals(rows)
      setError(undefined)
    }).catch((failure: unknown) => {
      if (cancelled) return
      setError(failure instanceof Error ? failure.message : String(failure))
    }).finally(() => {
      if (cancelled) return
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [controller])

  if (controller === undefined || t === undefined) return null

  const decide = (id: string, decision: 'accept' | 'reject'): void => {
    setBusyId(id)
    void controller.decide(id, decision).then((updated) => {
      setProposals(previous => previous.map(candidate => candidate.id === id ? updated : candidate))
      setError(undefined)
    }).catch((failure: unknown) => {
      setError(failure instanceof Error ? failure.message : String(failure))
    }).finally(() => {
      setBusyId(undefined)
    })
  }

  return (
    <section className={styles.page}>
      <h2 className={styles.title}>{t('title')}</h2>
      <p className={styles.intro}>{t('intro')}</p>
      {settings === undefined ? null : <ProviderSettings controller={settings} t={t} />}
      {error === undefined ? null : (
        <p className={styles.error} role="alert">{fill(t('failed'), { message: error })}</p>
      )}
      {loading
        ? <p className={styles.note}>{t('loading')}</p>
        : proposals.length === 0
          ? <p className={styles.note}>{t('empty')}</p>
          : (
            <ul className={styles.list}>
              {proposals.map(proposal => (
                <ProposalRow
                  key={proposal.id}
                  proposal={proposal}
                  busy={busyId === proposal.id}
                  t={t}
                  decide={decide}
                />
              ))}
            </ul>
          )}
      <p className={styles.rule}>{t('rule')}</p>
    </section>
  )
}
