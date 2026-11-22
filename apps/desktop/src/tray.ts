/** Desktop system tray: the always-present way back to a hidden window and the explicit quit entry. */

import { readFileSync } from 'node:fs'
import { Menu, nativeImage, Tray } from 'electron'
import type { DesktopLocale } from './locale.ts'

/** One extra raster added to the base tray image for a HiDPI display scale. */
export interface DesktopTrayIconRepresentation {
  readonly scaleFactor: number
  readonly width: number
  readonly height: number
  readonly path: string
}

/** Main-process actions the tray triggers; both run the same paths as the window and application menu. */
export interface DesktopTrayOptions {
  /**
   * Windows multi-size ICO or Linux 22 px PNG rendered by
   * `scripts/render-tray-icon.ts`; Windows picks the bitmap for the display
   * scale, while Linux reads the PNG.
   */
  readonly iconPath: string
  /** Linux HiDPI PNG added to the base image; Windows leaves this unset. */
  readonly iconRepresentations?: readonly DesktopTrayIconRepresentation[]
  readonly locale: () => DesktopLocale
  /** Show and focus the primary window. */
  readonly open: () => void
  /** Request quit through the same confirmation as every other quit entry. */
  readonly quit: () => void
}

/** Tray icon present for the whole run, not only while the window is hidden. */
export class DesktopTray {
  private tray: Tray | undefined

  /** @param options - Icon path, locale reader, and the open and quit actions. */
  constructor(private readonly options: DesktopTrayOptions) {
    const image = nativeImage.createFromPath(options.iconPath)
    for (const representation of options.iconRepresentations ?? []) {
      image.addRepresentation({
        scaleFactor: representation.scaleFactor,
        width: representation.width,
        height: representation.height,
        buffer: readFileSync(representation.path),
      })
    }
    const tray = new Tray(image)
    this.tray = tray
    tray.on('click', () => { options.open() })
    this.relabel()
  }

  /** Rebuild the tooltip and context menu in the current locale. */
  relabel(): void {
    const tray = this.tray
    if (tray === undefined) return
    const { messages } = this.options.locale()
    tray.setToolTip(messages.aboutProduct)
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: messages.openApplication, click: () => { this.options.open() } },
      { type: 'separator' },
      { label: messages.quitApplication, click: () => { this.options.quit() } },
    ]))
  }

  /** Remove the icon; called once the quit is confirmed so no dead icon outlives the process. */
  dispose(): void {
    const tray = this.tray
    this.tray = undefined
    tray?.destroy()
  }
}
