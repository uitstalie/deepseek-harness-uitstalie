/** Decide when repeated Linux GPU-process crashes should restart with hardware acceleration off. */

/** Consecutive GPU crashes required inside one window before a fallback restart. */
export const GPU_FALLBACK_THRESHOLD = 2

/** Sliding window in which GPU crashes count as one incident. */
export const GPU_FALLBACK_WINDOW_MS = 60_000

/** Relaunch marker that also keeps a crash log distinguishable from the first launch. */
export const GPU_FALLBACK_ARGUMENT = '--dsh-gpu-fallback'

/** Chromium switch that keeps the GPU process out of the next launch. */
export const GPU_DISABLE_ARGUMENT = '--disable-gpu'

/** Crash counters retained between GPU process exits in one application process. */
export interface GpuFallbackMemory {
  crashes: number
  firstCrashAt?: number
}

/** One observation from a GPU crash counter. */
export interface GpuFallbackObservation {
  readonly memory: GpuFallbackMemory
  readonly relaunch: boolean
}

/**
 * Count one GPU crash and decide whether it crosses the fallback threshold.
 * @param memory - counters from earlier crashes in this application process.
 * @param now - crash time in milliseconds.
 * @param windowMs - window after the first crash in which later crashes count.
 * @param threshold - number of crashes required to trigger a fallback.
 * @returns updated counters and whether a fallback restart is due.
 */
export function observeGpuCrash(
  memory: GpuFallbackMemory, now: number, windowMs = GPU_FALLBACK_WINDOW_MS, threshold = GPU_FALLBACK_THRESHOLD,
): GpuFallbackObservation {
  if (memory.firstCrashAt === undefined || now - memory.firstCrashAt > windowMs) {
    return { memory: { crashes: 1, firstCrashAt: now }, relaunch: false }
  }
  const crashes = memory.crashes + 1
  return { memory: { crashes, firstCrashAt: memory.firstCrashAt }, relaunch: crashes >= threshold }
}

/**
 * Build relaunch arguments that disable the GPU and mark the fallback launch.
 * @param argv - current application arguments, including the executable-relative arguments.
 * @returns arguments without stale fallback flags, ending in the two fallback switches.
 */
export function gpuFallbackArguments(argv: readonly string[]): string[] {
  return [
    ...argv.filter(argument => argument !== GPU_DISABLE_ARGUMENT && argument !== GPU_FALLBACK_ARGUMENT
      && argument !== '--enable-gpu'),
    GPU_DISABLE_ARGUMENT,
    GPU_FALLBACK_ARGUMENT,
  ]
}

/**
 * Report whether this process was started by the GPU fallback path.
 * @param argv - process arguments.
 * @returns true for a fallback launch.
 */
export function isGpuFallbackLaunch(argv: readonly string[]): boolean {
  return argv.includes(GPU_FALLBACK_ARGUMENT)
}
