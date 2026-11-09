/** Test-only internals; this module is not exported by the production package. */

import { AclSandbox } from './index.ts'

/**
 * Exercise the retired implementation's mocked Win32 failure paths. This class intentionally
 * bypasses the public fail-closed constructor and must never be used for real process isolation.
 */
export class UnsafeUnitTestAclSandbox extends AclSandbox {}
