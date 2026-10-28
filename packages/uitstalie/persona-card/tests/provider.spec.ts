import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPersonaCards, parsePersonaFile } from '../src/provider.ts'

const roots: string[] = []
const previousHome = process.env.DSH_HOME

afterEach(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const tempHome = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-persona-card-'))
  roots.push(root)
  process.env.DSH_HOME = root
  return root
}

const cardFile = (name: string): string => `---
schema: persona/v1
name: ${name}
description: test card
---

Longer body.
`

describe('parsePersonaFile', () => {
  it('reads frontmatter and appends the body', () => {
    const parsed = parsePersonaFile(cardFile('小鲸鱼'))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.name).toBe('小鲸鱼')
    expect(parsed.value.body).toBe('Longer body.')
  })

  it('rejects a file without frontmatter', () => {
    expect(parsePersonaFile('# no frontmatter').ok).toBe(false)
  })
})

describe('loadPersonaCards', () => {
  it('reads cards and skips an invalid file with a warning', async () => {
    const home = await tempHome()
    await mkdir(join(home, 'persona'), { recursive: true })
    await writeFile(join(home, 'persona', 'good.md'), cardFile('Good'))
    await writeFile(join(home, 'persona', 'bad.md'), 'not a card')
    const warnings: string[] = []
    const loaded = await loadPersonaCards({ warn: message => warnings.push(message) })
    expect([...loaded.cards.keys()]).toEqual(['good'])
    expect(warnings).toHaveLength(1)
  })

  it('is empty when the directory is missing', async () => {
    await tempHome()
    const loaded = await loadPersonaCards()
    expect(loaded.cards.size).toBe(0)
    expect(loaded.warnings).toEqual([])
  })
})
