/** CSS-module typing for the client build. */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
