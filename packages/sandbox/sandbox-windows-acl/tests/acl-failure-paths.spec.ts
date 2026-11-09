/**
 * ACL failure-path tests with minimal stub binding tables: every checked
 * Win32 call in the lock, DACL read-merge-write, and grant-skip sequence has
 * a failing counterpart. Revocation's legacy-label branches use crafted
 * in-memory ACL/SID buffers. Pure stubs — no real Win32 calls.
 */

import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import koffi from 'koffi'

import { grantWrite, revokeWrite, withPathLock } from '../src/acl.ts'
import { allocBytes, ptrAddress } from '../src/ffi.ts'
import type { NativePtr, Win32Bindings } from '../src/ffi.ts'
import * as abi from '../src/win32-abi.ts'

const PVOID = koffi.pointer('void')

/** The stub the grant/revoke happy path needs; every call succeeds until a field is overridden per test. */
function aclApi(overrides: Partial<Win32Bindings> = {}): Win32Bindings {
  return {
    getTempPathW: vi.fn((_length: number, buffer: Buffer) => {
      const temp = tmpdir().replace(/[\\/]$/u, '')
      buffer.write(temp, 'utf16le')
      return temp.length
    }),
    createFileW: vi.fn(() => 7n),
    lockFileEx: vi.fn(() => 1),
    unlockFileEx: vi.fn(() => 1),
    closeHandle: vi.fn(() => 1),
    getNamedSecurityInfoW: vi.fn((
      _path: unknown, _type: unknown, _info: unknown, _owner: unknown, _group: unknown,
      dacl: NativePtr, sacl: NativePtr, descriptor: NativePtr,
    ) => {
      koffi.encode(dacl, PVOID, 0n)
      koffi.encode(sacl, PVOID, 0n)
      koffi.encode(descriptor, PVOID, 0n)
      return 0
    }),
    setEntriesInAclW: vi.fn((_count: unknown, _entries: unknown, _old: unknown, newAcl: NativePtr) => {
      koffi.encode(newAcl, PVOID, 9n)
      return 0
    }),
    setNamedSecurityInfoW: vi.fn(() => 0),
    localAlloc: vi.fn(() => 11n),
    getLengthSid: vi.fn(() => 12),
    createWellKnownSid: vi.fn(() => 1),
    isValidSid: vi.fn(() => 1),
    initializeAcl: vi.fn(() => 1),
    addMandatoryAce: vi.fn(() => 1),
    localFree: vi.fn(() => 0n as NativePtr),
    getLastError: vi.fn(() => 5),
    formatMessageW: vi.fn(() => 0),
    ...overrides,
  } as Win32Bindings
}

/** One SID allocation: revision@0, subAuthorityCount@1, identifierAuthority@2 (6 bytes), subauthorities@8. */
function craftSid(revision: number, count: number, authority: number[] = [0, 0, 0, 0, 0, 5]): NativePtr {
  const sid = allocBytes(8)
  koffi.encode(sid, 'uint8', revision)
  koffi.encode(sid, 1, 'uint8', count)
  authority.forEach((byte, index) => {
    koffi.encode(sid, 2 + index, 'uint8', byte)
  })
  return sid
}

/** Write one 16-byte ACE (AceType@0, AceFlags@1, AceSize@2, Mask@4, inline SID@8) at `offset`. */
function writeAce(
  acl: NativePtr,
  offset: number,
  aceType: number,
  mask: number,
  sid: NativePtr,
  match: boolean,
): void {
  koffi.encode(acl, offset + 0, 'uint8', aceType)
  koffi.encode(acl, offset + 1, 'uint8', abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT)
  koffi.encode(acl, offset + 2, 'uint16', 16)
  koffi.encode(acl, offset + 4, 'uint32', mask)
  for (let byte = 0; byte < 8; byte++) {
    koffi.encode(acl, offset + 8 + byte, 'uint8', match
      ? koffi.decode(sid, byte, 'uint8') as number
      : byte === 0 ? 9 : 0)
  }
}

/** One in-memory ACL carrying a single inheritable ACE. */
function craftAcl(aceType: number, mask: number, sid: NativePtr, match: boolean): NativePtr {
  const acl = allocBytes(32)
  koffi.encode(acl, 'uint8', 2)
  koffi.encode(acl, 2, 'uint16', 24)
  koffi.encode(acl, 4, 'uint16', 1)
  writeAce(acl, 8, aceType, mask, sid, match)
  return acl
}

/** Encode a security-info read whose DACL and label ACL are the given pointers. */
function readStub(dacl: NativePtr | null, label: NativePtr | null, descriptor: bigint | null) {
  return vi.fn((
    _path: unknown, _type: unknown, _info: unknown, _owner: unknown, _group: unknown,
    daclSlot: NativePtr, saclSlot: NativePtr, descriptorSlot: NativePtr,
  ) => {
    koffi.encode(daclSlot, PVOID, dacl === null ? 0n : ptrAddress(dacl))
    koffi.encode(saclSlot, PVOID, label === null ? 0n : ptrAddress(label))
    koffi.encode(descriptorSlot, PVOID, descriptor ?? 0n)
    return 0
  })
}

describe('withPathLock failure paths', () => {
  it('fails closed when CreateFileW returns an invalid handle', () => {
    const api = aclApi({ createFileW: vi.fn(() => 0n as NativePtr) })
    expect(() => withPathLock(api, 'C:\\locked', () => {})).toThrowError(expect.objectContaining({ api: 'CreateFileW' }))
  })

  it('closes the handle and reports when LockFileEx fails', () => {
    const closeHandle = vi.fn(() => 1)
    const api = aclApi({ lockFileEx: vi.fn(() => 0), closeHandle })
    expect(() => withPathLock(api, 'C:\\locked', () => {})).toThrowError(expect.objectContaining({ api: 'LockFileEx' }))
    expect(closeHandle).toHaveBeenCalledWith(7n)
  })

  it('closes the handle and reports when UnlockFileEx fails', () => {
    const closeHandle = vi.fn(() => 1)
    const api = aclApi({ unlockFileEx: vi.fn(() => 0), closeHandle })
    expect(() => withPathLock(api, 'C:\\locked', () => {})).toThrowError(expect.objectContaining({ api: 'UnlockFileEx' }))
    expect(closeHandle).toHaveBeenCalledWith(7n)
  })

  it('reports a failed CloseHandle after a successful action', () => {
    const api = aclApi({ closeHandle: vi.fn(() => 0) })
    expect(() => withPathLock(api, 'C:\\locked', () => {})).toThrowError(expect.objectContaining({ api: 'CloseHandle' }))
  })
})

describe('mergeAndApply failure paths', () => {
  it('reports a SetEntriesInAclW failure when the directory carries no descriptor to free', () => {
    const api = aclApi({ setEntriesInAclW: vi.fn(() => 5) })
    expect(() => grantWrite(api, 'C:\\granted', craftSid(1, 0))).toThrowError(expect.objectContaining({ api: 'SetEntriesInAclW' }))
  })

  it('reports a NULL merged ACL when there is no descriptor to free', () => {
    const api = aclApi({ setEntriesInAclW: vi.fn(() => 0) })
    expect(() => grantWrite(api, 'C:\\granted', craftSid(1, 0))).toThrowError(expect.objectContaining({ api: 'SetEntriesInAclW' }))
  })

  it('frees the descriptor and reports when SetEntriesInAclW fails', () => {
    const localFree = vi.fn(() => 0n as NativePtr)
    const api = aclApi({ getNamedSecurityInfoW: readStub(null, null, 6n), setEntriesInAclW: vi.fn(() => 5), localFree })
    expect(() => grantWrite(api, 'C:\\granted', craftSid(1, 0))).toThrowError(expect.objectContaining({ api: 'SetEntriesInAclW' }))
    expect(localFree).toHaveBeenCalledWith(6n)
  })

  it('frees the descriptor and reports a NULL merged ACL', () => {
    const localFree = vi.fn(() => 0n as NativePtr)
    const api = aclApi({ getNamedSecurityInfoW: readStub(null, null, 6n), setEntriesInAclW: vi.fn(() => 0), localFree })
    expect(() => grantWrite(api, 'C:\\granted', craftSid(1, 0))).toThrowError(expect.objectContaining({ api: 'SetEntriesInAclW' }))
    expect(localFree).toHaveBeenCalledWith(6n)
  })

  it('frees the merged ACL and reports when SetNamedSecurityInfoW fails', () => {
    const localFree = vi.fn(() => 0n as NativePtr)
    const api = aclApi({ setNamedSecurityInfoW: vi.fn(() => 5), localFree })
    expect(() => grantWrite(api, 'C:\\granted', craftSid(1, 0))).toThrowError(expect.objectContaining({ api: 'SetNamedSecurityInfoW' }))
    expect(localFree).toHaveBeenCalledWith(9n)
  })

  it('reports a failed descriptor LocalFree after a successful apply', () => {
    const api = aclApi({ getNamedSecurityInfoW: readStub(null, null, 6n), localFree: vi.fn(() => 1n as NativePtr) })
    expect(() => grantWrite(api, 'C:\\granted', craftSid(1, 0))).toThrowError(expect.objectContaining({ api: 'LocalFree' }))
  })

  it('reports a failed merged-ACL LocalFree after a successful apply', () => {
    const api = aclApi({ localFree: vi.fn(() => 1n as NativePtr) })
    expect(() => grantWrite(api, 'C:\\granted', craftSid(1, 0))).toThrowError(expect.objectContaining({ api: 'LocalFree' }))
  })

  it('frees the descriptor when SetEntriesInAclW fails during a revoke', () => {
    const localFree = vi.fn(() => 0n as NativePtr)
    const sid = craftSid(1, 0)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(craftAcl(abi.ACCESS_ALLOWED_ACE_TYPE, abi.GRANT_MASK, sid, true), null, 6n),
      setEntriesInAclW: vi.fn(() => 5), localFree,
    })
    expect(() => revokeWrite(api, 'C:\\granted', sid)).toThrowError(expect.objectContaining({ api: 'SetEntriesInAclW' }))
    expect(localFree).toHaveBeenCalledWith(6n)
  })

  it('frees the descriptor on the null-merged-ACL path during a revoke', () => {
    const localFree = vi.fn(() => 0n as NativePtr)
    const sid = craftSid(1, 0)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(craftAcl(abi.ACCESS_ALLOWED_ACE_TYPE, abi.GRANT_MASK, sid, true), null, 6n),
      setEntriesInAclW: vi.fn(() => 0), localFree,
    })
    expect(() => revokeWrite(api, 'C:\\granted', sid)).toThrowError(expect.objectContaining({ api: 'SetEntriesInAclW' }))
    expect(localFree).toHaveBeenCalledWith(6n)
  })
})

describe('revokeWrite label handling', () => {
  function applyArgs(setNamedSecurityInfoW: Mock<Win32Bindings['setNamedSecurityInfoW']>): { information: number; sacl: unknown } {
    const call = setNamedSecurityInfoW.mock.calls.at(-1)
    return { information: call?.[2] as number, sacl: call?.[6] }
  }

  it('keeps a legacy label while another capability grant stands', () => {
    const sid = craftSid(1, 0)
    const otherSid = craftSid(1, 0, [0, 0, 0, 0, 0, 6])
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(craftAcl(abi.ACCESS_ALLOWED_ACE_TYPE, abi.GRANT_MASK, otherSid, true), 77n as NativePtr, 6n),
      setNamedSecurityInfoW,
    })
    expect(revokeWrite(api, 'C:\\granted', sid)).toBe(true)
    expect(applyArgs(setNamedSecurityInfoW).information & abi.LABEL_SECURITY_INFORMATION).toBe(0)
    expect(applyArgs(setNamedSecurityInfoW).sacl).toBeNull()
  })

  it('clears a legacy Low label once the last capability grant is revoked', () => {
    const sid = craftSid(1, 0)
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(craftAcl(abi.ACCESS_ALLOWED_ACE_TYPE, abi.GRANT_MASK, sid, true), 77n as NativePtr, 6n),
      setNamedSecurityInfoW,
    })
    expect(revokeWrite(api, 'C:\\granted', sid)).toBe(true)
    expect(applyArgs(setNamedSecurityInfoW).information & abi.LABEL_SECURITY_INFORMATION).toBe(abi.LABEL_SECURITY_INFORMATION)
    expect(applyArgs(setNamedSecurityInfoW).sacl).toBe(11n)
  })

  it('clears the legacy label when a malformed tiny DACL hides any foreign grant', () => {
    const acl = allocBytes(32)
    koffi.encode(acl, 'uint8', 2)
    koffi.encode(acl, 2, 'uint16', 4)
    koffi.encode(acl, 4, 'uint16', 1)
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({ getNamedSecurityInfoW: readStub(acl, null, 6n), setNamedSecurityInfoW })
    expect(revokeWrite(api, 'C:\\granted', craftSid(1, 0))).toBe(true)
    expect(applyArgs(setNamedSecurityInfoW).information & abi.LABEL_SECURITY_INFORMATION).toBe(abi.LABEL_SECURITY_INFORMATION)
    expect(applyArgs(setNamedSecurityInfoW).sacl).toBe(11n)
  })

  it('clears the legacy label when a lying ACE size hides any foreign grant', () => {
    const acl = allocBytes(32)
    koffi.encode(acl, 'uint8', 2)
    koffi.encode(acl, 2, 'uint16', 8)
    koffi.encode(acl, 4, 'uint16', 1)
    koffi.encode(acl, 10, 'uint16', 100)
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({ getNamedSecurityInfoW: readStub(acl, null, 6n), setNamedSecurityInfoW })
    expect(revokeWrite(api, 'C:\\granted', craftSid(1, 0))).toBe(true)
    expect(applyArgs(setNamedSecurityInfoW).information & abi.LABEL_SECURITY_INFORMATION).toBe(abi.LABEL_SECURITY_INFORMATION)
    expect(applyArgs(setNamedSecurityInfoW).sacl).toBe(11n)
  })
})

describe('the exact-ACE skip and ACL-walk defenses', () => {
  it('grantWrite skips the apply for an exact ACE and frees the descriptor without touching a label', () => {
    const sid = craftSid(1, 0)
    const localFree = vi.fn(() => 0n as NativePtr)
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(craftAcl(abi.ACCESS_ALLOWED_ACE_TYPE, abi.GRANT_MASK, sid, true), null, 6n),
      localFree, setNamedSecurityInfoW,
    })
    grantWrite(api, 'C:\\granted', sid)
    expect(setNamedSecurityInfoW).not.toHaveBeenCalled()
    expect(localFree).toHaveBeenCalledWith(6n)
  })

  it('grantWrite skips without freeing when no descriptor owns the exact ACE', () => {
    const sid = craftSid(1, 0)
    const localFree = vi.fn(() => 0n as NativePtr)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(craftAcl(abi.ACCESS_ALLOWED_ACE_TYPE, abi.GRANT_MASK, sid, true), null, null),
      localFree,
    })
    grantWrite(api, 'C:\\granted', sid)
    expect(localFree).not.toHaveBeenCalled()
  })

  it('grantWrite reports a failed descriptor LocalFree on the exact-ACE skip path', () => {
    const sid = craftSid(1, 0)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(craftAcl(abi.ACCESS_ALLOWED_ACE_TYPE, abi.GRANT_MASK, sid, true), null, 6n),
      localFree: vi.fn(() => 1n as NativePtr),
    })
    expect(() => grantWrite(api, 'C:\\granted', sid)).toThrowError(expect.objectContaining({ api: 'LocalFree' }))
  })

  it('does not skip an ACE with a different access type, mask, or trustee', () => {
    const sid = craftSid(1, 0)
    for (const acl of [
      craftAcl(abi.ACCESS_DENIED_ACE_TYPE, abi.GRANT_MASK, sid, true),
      craftAcl(abi.ACCESS_ALLOWED_ACE_TYPE, abi.DELETE, sid, true),
      craftAcl(abi.ACCESS_ALLOWED_ACE_TYPE, abi.GRANT_MASK, sid, false),
    ]) {
      const setNamedSecurityInfoW = vi.fn(() => 0)
      const api = aclApi({ getNamedSecurityInfoW: readStub(acl, null, 6n), setNamedSecurityInfoW })
      grantWrite(api, 'C:\\granted', sid)
      expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(1)
    }
  })

  it('falls back to the merge path for an implausible ACL size or ACE size', () => {
    for (const [aclSize, aceSize] of [[4, 16], [8, 100], [1_048_577, 16]]) {
      const acl = allocBytes(32)
      koffi.encode(acl, 'uint8', 2)
      koffi.encode(acl, 2, 'uint16', aclSize)
      koffi.encode(acl, 4, 'uint16', 1)
      koffi.encode(acl, 10, 'uint16', aceSize)
      const setNamedSecurityInfoW = vi.fn(() => 0)
      const api = aclApi({ getNamedSecurityInfoW: readStub(acl, null, 6n), setNamedSecurityInfoW })
      grantWrite(api, 'C:\\granted', craftSid(1, 0))
      expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(1)
    }
  })
})

describe('revokeWrite no-DACL path', () => {
  it('reports nothing to revoke when the read yields neither DACL nor descriptor', () => {
    const api = aclApi()
    expect(revokeWrite(api, 'C:\\granted', craftSid(1, 0))).toBe(false)
  })

  it('frees a descriptor that carries no DACL and reports nothing to revoke', () => {
    const localFree = vi.fn(() => 0n as NativePtr)
    const api = aclApi({ getNamedSecurityInfoW: readStub(null, null, 6n), localFree })
    expect(revokeWrite(api, 'C:\\granted', craftSid(1, 0))).toBe(false)
    expect(localFree).toHaveBeenCalledWith(6n)
  })

  it('reports a failed descriptor LocalFree on the no-DACL path', () => {
    const api = aclApi({ getNamedSecurityInfoW: readStub(null, null, 6n), localFree: vi.fn(() => 1n as NativePtr) })
    expect(() => revokeWrite(api, 'C:\\granted', craftSid(1, 0))).toThrowError(expect.objectContaining({ api: 'LocalFree' }))
  })
})
