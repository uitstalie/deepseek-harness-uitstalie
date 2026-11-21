/** Render the standard hicolor app icon set a Linux package installs. */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Sizes every current hicolor theme indexes under `apps`. The 1104 px source is
 * not one of them, so electron-builder would otherwise install a single
 * `1104x1104` directory that no theme lookup finds.
 */
export const LINUX_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512]

/**
 * Write one PNG per standard hicolor size for electron-builder's icon directory.
 * @param {string} source - Source PNG, at least as large as the largest size.
 * @param {string} destination - Directory receiving `<size>x<size>.png` files.
 * @returns {Promise<string>} The destination directory.
 */
export async function writeLinuxIconSet(source, destination) {
  const { default: sharp } = await import('sharp')
  await mkdir(destination, { recursive: true })
  const sizes = [...LINUX_ICON_SIZES].sort((left, right) => left - right)
  for (const size of sizes) {
    const png = await sharp(source).resize(size, size, { fit: 'contain' }).png().toBuffer()
    await writeFile(join(destination, `${size}x${size}.png`), png)
  }
  return destination
}
