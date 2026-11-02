/**
 * plugin/github — one read-only look at a repository's open issues.
 *
 * A Source's whole job is to notice. The ledger stays the store of work, so this module only turns
 * GitHub's issue list into the items a Source can offer, and nothing here writes to GitHub. The
 * runner is a parameter so a test never needs the network or a credential.
 *
 * @module @deepseek-ai/dsh-jira-agent/github
 */

import { execFile } from 'node:child_process'

/** One open issue as the source reads it. */
export interface GithubItem {
  /** The repository-local issue number. */
  readonly number: number
  /** The title, which becomes the ledger issue's summary. */
  readonly title: string
  /** The canonical URL, and the identity the ledger deduplicates on. */
  readonly url: string
  /** The login that opened it, when GitHub reported one. */
  readonly author?: string
}

/** Runs one `gh` invocation and answers its stdout. The seam a test replaces. */
export type GhRunner = (args: readonly string[]) => Promise<string>

/**
 * The real runner: `gh` with the operator's own credentials.
 *
 * No token is stored anywhere (the ledger's rule for git credentials applies here too), and a
 * non-zero exit rejects so the caller can report it instead of parsing an error page.
 */
export const ghRunner: GhRunner = async args => new Promise<string>((resolve, reject) => {
  execFile('gh', [...args], {
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  }, (error, stdout) => {
    if (error !== null) reject(error)
    else resolve(stdout)
  })
})

/** The fields asked of `gh`; the list is the contract between the command and the parser. */
const FIELDS = 'number,title,url,author'

/**
 * Read one repository's open issues.
 * @param repo - `owner/name`.
 * @param runner - the command runner; defaults to the real `gh`.
 * @param limit - how many open issues to ask for.
 * @returns the items, in the order `gh` reported them.
 * @throws when the command fails or its answer is not a JSON array.
 */
export const pollGithub = async (
  repo: string,
  runner: GhRunner = ghRunner,
  limit = 30,
): Promise<readonly GithubItem[]> => {
  const stdout = await runner([
    'issue', 'list',
    '--repo', repo,
    '--state', 'open',
    '--limit', String(limit),
    '--json', FIELDS,
  ])
  const parsed: unknown = JSON.parse(stdout)
  if (!Array.isArray(parsed)) throw new Error('gh returned no issue list')
  return Object.freeze(parsed.flatMap((raw): GithubItem[] => {
    if (typeof raw !== 'object' || raw === null) return []
    const row = raw as Record<string, unknown>
    const number = typeof row.number === 'number' ? row.number : undefined
    const title = typeof row.title === 'string' ? row.title : undefined
    const url = typeof row.url === 'string' ? row.url : undefined
    if (number === undefined || title === undefined || url === undefined) return []
    const login = (row.author as { login?: unknown } | undefined)?.login
    return [{ number, title, url, ...(typeof login === 'string' ? { author: login } : {}) }]
  }))
}
