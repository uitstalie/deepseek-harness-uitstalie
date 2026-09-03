/**
 * 共享的小表单字段组件（DraftForm 与 MyRoutes 的编辑表单共用）。
 * 纯 props：label + value + onChange。
 *
 * @module @deepseek-ai/dsh-client-ui-models-dev/fields
 */

import styles from './ModelsDevSection.module.css'

/** 一个标签 + 文本输入行。 */
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

/** 一个标签 + JSON 文本域行。 */
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
