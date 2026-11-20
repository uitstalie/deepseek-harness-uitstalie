import { describe, expect, it } from 'vitest'
import { GPU_DISABLE_ARGUMENT, GPU_FALLBACK_ARGUMENT, gpuFallbackArguments, isGpuFallbackLaunch, observeGpuCrash } from '../src/gpu-fallback.ts'

describe('desktop GPU fallback', () => {
  it('requires two crashes inside the window before relaunching', () => {
    const first = observeGpuCrash({ crashes: 0 }, 1_000)
    expect(first).toEqual({ memory: { crashes: 1, firstCrashAt: 1_000 }, relaunch: false })
    const second = observeGpuCrash(first.memory, 2_000)
    expect(second).toEqual({ memory: { crashes: 2, firstCrashAt: 1_000 }, relaunch: true })
  })

  it('starts a new window after a quiet period', () => {
    const stale = observeGpuCrash({ crashes: 2, firstCrashAt: 1_000 }, 62_000)
    expect(stale.memory).toEqual({ crashes: 1, firstCrashAt: 62_000 })
    expect(stale.relaunch).toBe(false)
  })

  it('replaces stale fallback switches without duplicating them', () => {
    const args = gpuFallbackArguments(['--no-sandbox', '--enable-gpu', GPU_FALLBACK_ARGUMENT, GPU_DISABLE_ARGUMENT])
    expect(args).toEqual(['--no-sandbox', GPU_DISABLE_ARGUMENT, GPU_FALLBACK_ARGUMENT])
    expect(isGpuFallbackLaunch(args)).toBe(true)
    expect(isGpuFallbackLaunch(['--no-sandbox'])).toBe(false)
  })
})
