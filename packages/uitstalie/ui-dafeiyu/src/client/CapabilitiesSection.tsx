/**
 * The capability list's settings page: every provider the organizer knows,
 * with its live state, its enable switch, and a link to its own settings page.
 *
 * The component is presentation only: every fact arrives through the inject
 * face, every action calls the controller or the shell, and every sentence
 * comes from the `settings.capabilities` dictionary.
 *
 * @module @deepseek-ai/dsh-client-ui-dafeiyu/CapabilitiesSection
 */

import { useEffect } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { CapabilityStatus } from '@deepseek-ai/dsh-dafeiyu/types'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import { fill, type CapabilityKey } from './locales.ts'
import type { CapabilitiesState, CapabilityStore } from './store.ts'
import styles from './CapabilitiesSection.module.css'

/** What the registration injects into the page. */
export interface CapabilitiesSectionInjected {
  /** The page controller (load, switch). */
  controller: CapabilityStore
  /** Start the first read; a mounted-but-unopened page does not touch the host. */
  activate: () => void
  hooks: {
    /** The page snapshot, bound by the renderer as `useSnapshot`. */
    snapshot: SnapshotStore<CapabilitiesState>
  }
  /** This page's copy (`settings.capabilities`). */
  t: (key: CapabilityKey) => string
}

/** The page's props: the inject face plus the shell's section affordances. */
export type CapabilitiesSectionProps =
  & Partial<InjectFace<CapabilitiesSectionInjected>>
  & { readonly openSection?: SettingsSectionOwnerProps['openSection'] }

/** The badge/copy key for one public state. */
function stateKeyOf(state: CapabilityStatus['state']): CapabilityKey {
  switch (state) {
    case 'active': return 'stateActive'
    case 'failed': return 'stateFailed'
    case 'missing': return 'stateMissing'
    case 'disabled': return 'stateDisabled'
  }
}

/** One capability row: identity, state, failure, switch, and the provider's own page. */
function CapabilityRow(props: {
  readonly entry: CapabilityStatus
  readonly pending: boolean
  readonly t: (key: CapabilityKey) => string
  readonly openSection: SettingsSectionOwnerProps['openSection']
  readonly onToggle: (enabled: boolean) => void
}) {
  const { entry, pending, t, openSection, onToggle } = props
  const name = entry.label ?? entry.id
  const sectionId = entry.settings?.sectionId
  return (
    <li className={styles.item}>
      <div className={styles.head}>
        <span className={styles.name}>{name}</span>
        <span className={`${styles.badge} ${styles[entry.state]}`}>{t(stateKeyOf(entry.state))}</span>
      </div>
      {entry.description === undefined ? null : <p className={styles.description}>{entry.description}</p>}
      {entry.failure === undefined ? null : (
        <p className={styles.failureDetail}>{fill(t('failure'), { message: entry.failure })}</p>
      )}
      {entry.present ? null : <p className={styles.note}>{t('missingNote')}</p>}
      <div className={styles.controls}>
        <button
          type="button"
          role="switch"
          aria-checked={entry.enabled}
          aria-label={fill(t(entry.enabled ? 'turnOff' : 'turnOn'), { name })}
          className={entry.enabled ? `${styles.toggle} ${styles.toggleOn}` : styles.toggle}
          disabled={pending || !entry.present}
          onClick={() => { onToggle(!entry.enabled) }}
        >
          <span className={styles.track} aria-hidden="true"><span className={styles.knob} /></span>
          <span className={styles.toggleLabel}>{t(entry.enabled ? 'stateActive' : 'stateDisabled')}</span>
        </button>
        {sectionId === undefined || openSection === undefined
          ? null
          : (
            <button
              type="button"
              className={styles.action}
              onClick={() => { openSection(sectionId) }}
            >
              {t('openSettings')}
            </button>
          )}
      </div>
    </li>
  )
}

/** The capability list settings page. */
export function CapabilitiesSection(props: CapabilitiesSectionProps) {
  const { controller, useSnapshot, t, activate, openSection } = props
  useEffect(() => { activate?.() }, [activate])
  // The assembly guarantees controller/useSnapshot/t; partial props are the test path.
  if (controller === undefined || useSnapshot === undefined || t === undefined) return null
  const state = useSnapshot(snapshot => snapshot)

  return (
    <div className={styles.section}>
      <h2 className={styles.title}>{t('title')}</h2>
      <p className={styles.intro}>{t('intro')}</p>
      {state.actionError !== null
        ? <div className={styles.alert} role="alert">{fill(t('updateFailed'), { message: state.actionError })}</div>
        : null}
      {state.refused
        ? <div className={styles.alert} role="alert">{t('updateRefused')}</div>
        : null}
      {state.status === 'error'
        ? (
          <div className={styles.alert} role="alert">
            <span>{fill(t('failed'), { message: state.error ?? '' })}</span>
            <button type="button" className={styles.action} onClick={() => { void controller.load() }}>
              {t('retry')}
            </button>
          </div>
        )
        : null}
      {state.status === 'loading' && state.entries.length === 0
        ? <p className={styles.note}>{t('loading')}</p>
        : null}
      {state.status === 'ready' && state.entries.length === 0
        ? <p className={styles.note}>{t('empty')}</p>
        : null}
      <ul className={styles.list}>
        {state.entries.map(entry => (
          <CapabilityRow
            key={entry.id}
            entry={entry}
            pending={state.pending === entry.id}
            t={t}
            openSection={openSection}
            onToggle={(enabled) => { void controller.setEnabled(entry.id, enabled) }}
          />
        ))}
      </ul>
      <p className={styles.note}>{t('gateNote')}</p>
    </div>
  )
}
