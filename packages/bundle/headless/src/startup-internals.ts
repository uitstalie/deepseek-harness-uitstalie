/**
 * Process facts the startup provider reads, kept out of the `./startup` entry
 * so substituting them in tests adds no public package API.
 * @module @deepseek-ai/dsh-headless/startup-internals
 */

/** Process facts the provider reads; tests substitute them. */
export const internals: {
  stdinIsTty: () => boolean
  stdout: { write(chunk: string): unknown }
  // uitstalie-deepseek-flash, 2026/11/06, DH-905, stderr carries the deprecated-flag notice
  stderr: { write(chunk: string): unknown }
} = {
  stdinIsTty: () => process.stdin.isTTY,
  stdout: process.stdout,
  // uitstalie-deepseek-flash, 2026/11/06, DH-905, stderr carries the deprecated-flag notice
  stderr: process.stderr,
}
