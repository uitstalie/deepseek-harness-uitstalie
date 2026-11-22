/** Allocate the RPM release that distinguishes repeated local Linux builds. */

/**
 * Read and advance the per-target RPM release counter.
 * @param statePath - JSON file holding the last sequence allocated for this target.
 * @param override - Explicit release, which leaves the state file untouched.
 * @returns The release to pass to fpm as `--iteration`.
 */
export declare function nextLinuxRpmRelease(statePath: string, override?: string): Promise<string>
