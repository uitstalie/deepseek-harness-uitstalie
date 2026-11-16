/**
 * Shared small form field components (used by both DraftForm and the MyRoutes edit form).
 * Pure props: label + value + onChange.
 *
 * @module @deepseek-ai/dsh-client-ui-models-dev/fields
 */

import styles from './ModelsDevSection.module.css'

/** A label + text input row. */
export function TextField(props: {
  label: string
  value: string
  placeholder?: string
  type?: string
  onChange: (value: string) => void
}) {
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{props.label}</span>
      <input
        className={styles.input}
        type={props.type ?? 'text'}
        value={props.value}
        {...(props.placeholder === undefined ? {} : { placeholder: props.placeholder })}
        onChange={(event) => { props.onChange(event.target.value) }}
      />
    </label>
  )
}

/** A label + JSON textarea row. */
export function JsonField(props: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{props.label}</span>
      <textarea
        className={styles.textarea}
        rows={2}
        value={props.value}
        onChange={(event) => { props.onChange(event.target.value) }}
      />
    </label>
  )
}
