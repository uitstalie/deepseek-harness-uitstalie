/** Render the standard hicolor app icon set a Linux package installs. */

/** Sizes every current hicolor theme indexes under `apps`. */
export declare const LINUX_ICON_SIZES: readonly number[]

/**
 * Write one PNG per standard hicolor size for electron-builder's icon directory.
 * @param source - Source PNG, at least as large as the largest size.
 * @param destination - Directory receiving `<size>x<size>.png` files.
 * @returns The destination directory.
 */
export declare function writeLinuxIconSet(source: string, destination: string): Promise<string>
