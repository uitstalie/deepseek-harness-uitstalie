import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { LINUX_ICON_SIZES, writeLinuxIconSet } from '../scripts/linux-icons.mjs'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-linux-icons-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('Linux package icons', () => {
  it('renders one PNG per hicolor size from the 1104 px source', async () => {
    const destination = await temporaryDirectory()
    await writeLinuxIconSet(fileURLToPath(new URL('../resources/icon.png', import.meta.url)), destination)
    const files = await readdir(destination)
    expect(files.sort()).toEqual(LINUX_ICON_SIZES.map(size => `${size}x${size}.png`).sort())
    for (const size of LINUX_ICON_SIZES) {
      const png = await readFile(join(destination, `${size}x${size}.png`))
      expect(png.subarray(1, 4).toString()).toBe('PNG')
      expect(png.readUInt32BE(16)).toBe(size)
      expect(png.readUInt32BE(20)).toBe(size)
      expect((await stat(join(destination, `${size}x${size}.png`))).size).toBeGreaterThan(0)
    }
  })

  it('installs the size set through the RPM icon directory and a pixmap fallback', async () => {
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const config = createElectronBuilderConfig({
      DSH_DESKTOP_APP_ID: 'com.example.linux-packaging',
      DSH_DESKTOP_TARGET_PLATFORM: 'linux',
      DSH_DESKTOP_TARGET_ARCH: 'x64',
      DSH_DESKTOP_UNSIGNED: '1',
    }, 'linux', 'x64')
    expect(config.linux.target).toEqual(['rpm', 'AppImage'])
    expect(config.linux.icon).toMatch(/[\\/]linux-icons$/u)
    const posttrans = fileURLToPath(new URL('../packaging/linux/posttrans.sh', import.meta.url))
    expect(config.rpm.fpm).toEqual([
      '--rpm-posttrans',
      posttrans,
      expect.stringMatching(/[\\/]256x256\.png=\/usr\/share\/pixmaps\/deepseek-harness\.png$/u),
    ])
    const script = await readFile(posttrans, 'utf8')
    expect(script).toContain('gtk-update-icon-cache -f -t /usr/share/icons/hicolor')
    expect(script).toContain('update-desktop-database /usr/share/applications')
    await config.beforeBuild()
    expect((await readdir(config.linux.icon)).sort()).toEqual(LINUX_ICON_SIZES.map(size => `${size}x${size}.png`).sort())
  })
})
