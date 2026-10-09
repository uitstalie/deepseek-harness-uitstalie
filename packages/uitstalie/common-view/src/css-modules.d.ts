/** CSS Modules used by the common-view package resolve to their local class names. */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}
