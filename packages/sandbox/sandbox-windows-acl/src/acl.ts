/**
 * ACL editing helpers: grant/revoke a capability SID on a directory via
 * SetEntriesInAclW + SetNamedSecurityInfoW. Every API call is checked and every
 * failure is reported with the API name, the exact Win32 code, the formatted
 * system text, and the affected path.
 *
 * New grants modify only the capability-SID allow ACE. They do not add an
 * Everyone delete deny or change mandatory integrity labels. Revocation retains
 * the legacy private-temp lifecycle: after the last capability grant is removed,
 * it restores Medium for the label left by an earlier backend.
 *
 * Concurrency: grants are read-merge-write against the directory's CURRENT
 * DACL, and the whole get-merge-set sequence runs under a per-path exclusive
 * LockFileEx lock (see {@link withPathLock}) so concurrent sandbox instances
 * cannot clobber each other's ACEs.
 * @module @deepseek-ai/dsh-sandbox-windows-acl/acl
 */

import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { allocOverlapped, allocPtrSlot, decodePtr, decodeUint8At, decodeUint16At, decodeUint32At, getTempPath, isInvalidHandle, isNullPtr, ptrAddress, sameSidAt, throwLastError, throwWin32 } from './ffi.ts'
import type { NativePtr, Win32Bindings } from './ffi.ts'
import { makeWellKnownSid } from './token.ts'
import * as abi from './win32-abi.ts'

/**
 * Pack one EXPLICIT_ACCESS_W (48 bytes, layout verified by abi-probe.cpp):
 * perms@0, mode@4, inheritance@8, Trustee@16 { pMultipleTrustee@16,
 * MultipleTrusteeOperation@24, TrusteeForm@28, TrusteeType@32, ptstrName@40 }.
 * `permissions` is the access mask; the POC passes 0 for REVOKE_ACCESS, which
 * removes every ACE for the trustee. `inheritance` defaults to children of
 * both kinds.
 * @param sidPtr - the trustee SID the entry names.
 * @param mode - the access mode (GRANT_ACCESS, DENY_ACCESS, or REVOKE_ACCESS).
 * @param permissions - the access mask to grant or deny (0 for REVOKE_ACCESS).
 * @param inheritance - the ACE inheritance flags.
 * @returns the packed entry buffer.
 */
export function buildExplicitAccess(
  sidPtr: NativePtr,
  mode: number,
  permissions: number,
  inheritance: number = abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT,
): Buffer {
  const entry = Buffer.alloc(abi.EXPLICIT_ACCESS_W_SIZE)
  entry.writeUInt32LE(permissions, 0) // grfAccessPermissions
  entry.writeUInt32LE(mode, 4) // grfAccessMode
  entry.writeUInt32LE(inheritance, 8) // grfInheritance
  entry.writeUInt32LE(abi.NO_MULTIPLE_TRUSTEE, 24) // Trustee.MultipleTrusteeOperation
  entry.writeUInt32LE(abi.TRUSTEE_IS_SID, 28) // Trustee.TrusteeForm
  entry.writeUInt32LE(abi.TRUSTEE_IS_UNKNOWN, 32) // Trustee.TrusteeType
  entry.writeBigUInt64LE(ptrAddress(sidPtr), 40) // Trustee.ptstrName = the capability SID
  return entry
}

/**
 * One lock file per protected path: `<GetTempPathW()>\dsh-acl-locks\<first 16
 * hex of sha256(lowercased path)>.lock`. The lock root derives from
 * GetTempPathW (never from runner argv or DSH_HOME), and the lowercasing
 * maps Windows's case-insensitive path spellings onto one lock.
 * @param api - the binding table.
 * @param path - the protected directory (absolute).
 * @returns the lock file path for that directory.
 */
export function lockFilePath(api: Win32Bindings, path: string): string {
  const digest = createHash('sha256').update(path.toLowerCase()).digest('hex').slice(0, 16)
  return join(getTempPath(api), 'dsh-acl-locks', `${digest}.lock`)
}

/**
 * Run `action` holding the per-path exclusive lock: CreateFileW
 * (OPEN_ALWAYS, shared read/write but NOT delete — a deletable lock file
 * could be removed and recreated under the holder, letting two processes
 * hold "the same" lock), then a one-byte LockFileEx
 * (LOCKFILE_EXCLUSIVE_LOCK, zeroed OVERLAPPED = lock from offset 0 on the
 * synchronous handle — see allocOverlapped for why not NULL), then
 * UnlockFileEx + CloseHandle. Fail-closed: open/lock/unlock/close failures
 * throw like every other Win32 call in this package; an `action` failure
 * still unlocks (best-effort) and rethrows the original error.
 * @param api - the binding table.
 * @param path - the protected directory (absolute).
 * @param action - the get-merge-set sequence to serialize.
 * @returns the action's result.
 */
export function withPathLock<T>(api: Win32Bindings, path: string, action: () => T): T {
  const lockPath = lockFilePath(api, path)
  mkdirSync(dirname(lockPath), { recursive: true })
  const handle = api.createFileW(
    lockPath,
    abi.GENERIC_READ | abi.GENERIC_WRITE,
    abi.FILE_SHARE_READ | abi.FILE_SHARE_WRITE,
    null, abi.OPEN_ALWAYS, 0, null,
  )
  if (isInvalidHandle(handle)) throwLastError(api, 'CreateFileW', lockPath)
  const overlapped = allocOverlapped() // stays zeroed: offset 0, hEvent NULL
  if (api.lockFileEx(handle, abi.LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, overlapped) === 0) {
    const win32Code = api.getLastError()
    api.closeHandle(handle) // best-effort on the lock-failure path
    throwWin32(api, 'LockFileEx', win32Code, lockPath)
  }

  let result: T
  try {
    result = action()
  } catch (error) {
    // Best-effort release on the action-failure path: cleanup failures must
    // not mask the action's error.
    api.unlockFileEx(handle, 0, 1, 0, overlapped)
    api.closeHandle(handle)
    throw error
  }
  if (api.unlockFileEx(handle, 0, 1, 0, overlapped) === 0) {
    const win32Code = api.getLastError()
    api.closeHandle(handle) // best-effort on the unlock-failure path
    throwWin32(api, 'UnlockFileEx', win32Code, lockPath)
  }
  if (api.closeHandle(handle) === 0) throwLastError(api, 'CloseHandle', `lock file ${lockPath}`)
  return result
}

/**
 * Read the directory's current explicit DACL and optional mandatory label via
 * GetNamedSecurityInfoW. The returned ACL pointers sit INSIDE the security
 * descriptor allocation: only the descriptor may be LocalFree'd, and it must
 * not be freed before SetEntriesInAclW has consumed the DACL.
 * @param api - the binding table.
 * @param path - the directory whose DACL and optional label are read.
 * @param includeLabel - whether revocation also reads the legacy label.
 * @returns the current explicit DACL and label ACL plus their owning descriptor.
 */
function readCurrentSecurity(
  api: Win32Bindings,
  path: string,
  includeLabel: boolean,
): { oldAcl: NativePtr | null; labelAcl: NativePtr | null; descriptor: NativePtr | null } {
  const ownerSlot = allocPtrSlot()
  const groupSlot = allocPtrSlot()
  const daclSlot = allocPtrSlot()
  const saclSlot = allocPtrSlot()
  const descriptorSlot = allocPtrSlot()
  const readResult = api.getNamedSecurityInfoW(
    path, abi.SE_FILE_OBJECT,
    abi.DACL_SECURITY_INFORMATION | (includeLabel ? abi.LABEL_SECURITY_INFORMATION : 0),
    ownerSlot, groupSlot, daclSlot, saclSlot, descriptorSlot,
  )
  if (readResult !== abi.ERROR_SUCCESS) throwWin32(api, 'GetNamedSecurityInfoW', readResult, path)
  return { oldAcl: decodePtr(daclSlot), labelAcl: decodePtr(saclSlot), descriptor: decodePtr(descriptorSlot) }
}

/** Build a Medium label for a revoked private temp, without consulting runner paths. */
function buildMediumLabelAcl(api: Win32Bindings): NativePtr {
  const sid = makeWellKnownSid(api, abi.WinMediumLabelSid)
  if (isNullPtr(sid)) throwLastError(api, 'LocalAlloc', 'Medium mandatory label SID')
  const sidLength = api.getLengthSid(sid)
  const aclLength = abi.ACL_HEADER_SIZE + abi.MANDATORY_ACE_OVERHEAD + sidLength
  const acl = api.localAlloc(abi.LPTR, aclLength)
  if (isNullPtr(acl)) {
    const code = api.getLastError()
    api.localFree(sid)
    throwWin32(api, 'LocalAlloc', code, 'Medium mandatory label ACL')
  }
  if (api.initializeAcl(acl, aclLength, abi.ACL_REVISION) === 0) {
    const code = api.getLastError()
    api.localFree(acl)
    api.localFree(sid)
    throwWin32(api, 'InitializeAcl', code, 'Medium mandatory label ACL')
  }
  const added = api.addMandatoryAce(
    acl, abi.ACL_REVISION, abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT, abi.SYSTEM_MANDATORY_LABEL_NO_WRITE_UP, sid,
  )
  if (added === 0) {
    const code = api.getLastError()
    api.localFree(acl)
    api.localFree(sid)
    throwWin32(api, 'AddMandatoryAce', code, 'Medium mandatory label ACL')
  }
  api.localFree(sid)
  return acl
}

type LabelEdit = { kind: 'medium'; acl: NativePtr } | { kind: 'keep' }

/**
 * Shared tail of grantWrite and revokeWrite: merge `entries` into `oldAcl`
 * (null = no explicit DACL yet; SetEntriesInAclW builds one from scratch),
 * free the descriptor before applying the merged ACL, apply the merged DACL
 * with an optional label clear in one SetNamedSecurityInfoW call, then free
 * every ACL this call owns — checking each call and reporting with the
 * caller's label.
 * @param api - the binding table.
 * @param path - the directory the DACL and label edits apply to.
 * @param entries - packed EXPLICIT_ACCESS_W records to merge (grant, deny, or revoke).
 * @param oldAcl - the current explicit DACL (from {@link readCurrentSecurity}).
 * @param labelEdit - whether revocation clears the legacy label.
 * @param descriptor - the descriptor allocation owning `oldAcl`.
 * @param label - the caller's name for error details.
 */
function mergeAndApply(
  api: Win32Bindings,
  path: string,
  entries: Buffer,
  oldAcl: NativePtr | null,
  labelEdit: LabelEdit,
  descriptor: NativePtr | null,
  label: string,
): void {
  const newAclSlot = allocPtrSlot()
  const labelAcl = labelEdit.kind === 'medium' ? labelEdit.acl : null
  const releaseLabel = (): void => {
    if (labelAcl !== null) api.localFree(labelAcl)
  }
  const mergeResult = api.setEntriesInAclW(entries.length / abi.EXPLICIT_ACCESS_W_SIZE, entries, oldAcl, newAclSlot)
  if (mergeResult !== abi.ERROR_SUCCESS) {
    if (descriptor !== null) api.localFree(descriptor) // frees the ACL block too
    releaseLabel()
    throwWin32(api, 'SetEntriesInAclW', mergeResult, `${label}(${path})`)
  }
  const newAcl = decodePtr(newAclSlot)
  if (newAcl === null) {
    if (descriptor !== null) api.localFree(descriptor)
    releaseLabel()
    throwWin32(api, 'SetEntriesInAclW', api.getLastError(), `${label}(${path}): null new ACL`)
  }

  // The descriptor block (oldAcl included) is dead after the merge.
  const freedDescriptor = descriptor !== null ? api.localFree(descriptor) : null
  const applyResult = api.setNamedSecurityInfoW(
    path, abi.SE_FILE_OBJECT,
    labelEdit.kind === 'keep' ? abi.DACL_SECURITY_INFORMATION : abi.DACL_SECURITY_INFORMATION | abi.LABEL_SECURITY_INFORMATION,
    null, null, newAcl, labelAcl,
  )
  const freedNew = api.localFree(newAcl)
  const freedLabel = labelAcl === null ? null : api.localFree(labelAcl)
  if (applyResult !== abi.ERROR_SUCCESS) throwWin32(api, 'SetNamedSecurityInfoW', applyResult, `${label}(${path})`)
  if (freedDescriptor !== null && !isNullPtr(freedDescriptor)) throwLastError(api, 'LocalFree', `${label}(${path}) descriptor`)
  if (!isNullPtr(freedNew)) throwLastError(api, 'LocalFree', `${label}(${path}) new ACL`)
  if (freedLabel !== null && !isNullPtr(freedLabel)) throwLastError(api, 'LocalFree', `${label}(${path}) label ACL`)
}

/**
 * True when the explicit DACL already carries the EXACT entry
 * `(aceType, inheritance, mask, trustee SID)`. Every field is read through
 * koffi.decode at pointer offsets. The ACE's SID is INLINE (embedded in the
 * ACE after the 4-byte mask). Allowed and denied ACEs share the Mask@4/SID@8
 * layout. A malformed header reads as "no exact entry" so the caller falls
 * back to the merge-apply path, which owns the robust failure handling.
 * @param acl - the current explicit DACL pointer (from {@link readCurrentSecurity}).
 * @param aceType - the ACE type to match.
 * @param inheritance - the ACE inheritance flags to match.
 * @param mask - the access mask to match.
 * @param sidPtr - the trustee SID to match.
 * @returns whether the exact entry is already present.
 */
function hasExactEntry(acl: NativePtr, aceType: number, inheritance: number, mask: number, sidPtr: NativePtr): boolean {
  const aclSize = decodeUint16At(acl, 2)
  const aceCount = decodeUint16At(acl, 4)
  if (aclSize < 8 || aclSize > 1_048_576) return false
  let offset = 8 // the first ACE follows the 8-byte ACL header
  for (let index = 0; index < aceCount; index++) {
    // ACE_HEADER: AceType@0, AceFlags@1, AceSize@2 (WORD); Mask@4, inline SID@8.
    const aceSize = decodeUint16At(acl, offset + 2)
    if (aceSize < 8 || offset + aceSize > aclSize) return false
    const exact = decodeUint8At(acl, offset) === aceType
      && decodeUint8At(acl, offset + 1) === inheritance
      && decodeUint32At(acl, offset + 4) === mask
    if (exact && sameSidAt(acl, offset + 8, sidPtr, 0)) return true
    offset += aceSize
  }
  return false
}

/** Whether the exact capability allow ACE already stands. */
function hasExactGrant(oldAcl: NativePtr, sidPtr: NativePtr): boolean {
  return hasExactEntry(oldAcl, abi.ACCESS_ALLOWED_ACE_TYPE, abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT, abi.GRANT_MASK, sidPtr)
}

/**
 * True when a capability grant for a SID OTHER than `sidPtr` stands on this
 * DACL — the condition under which a revoke must leave a legacy label in place.
 * @param oldAcl - the current explicit DACL pointer (from {@link readCurrentSecurity}).
 * @param sidPtr - the capability SID being revoked.
 * @returns whether another capability grant remains.
 */
function hasForeignGrant(oldAcl: NativePtr, sidPtr: NativePtr): boolean {
  const aclSize = decodeUint16At(oldAcl, 2)
  const aceCount = decodeUint16At(oldAcl, 4)
  if (aclSize < 8 || aclSize > 1_048_576) return false
  let offset = 8
  for (let index = 0; index < aceCount; index++) {
    const aceSize = decodeUint16At(oldAcl, offset + 2)
    if (aceSize < 8 || offset + aceSize > aclSize) return false
    const isGrant = decodeUint8At(oldAcl, offset) === abi.ACCESS_ALLOWED_ACE_TYPE
      && decodeUint32At(oldAcl, offset + 4) === abi.GRANT_MASK
    if (isGrant && !sameSidAt(oldAcl, offset + 8, sidPtr, 0)) return true
    offset += aceSize
  }
  return false
}

/**
 * Grant `GRANT_MASK` (Write+Delete, displays as "Modify") to the capability SID
 * on `path`. The operation changes only the DACL: it adds no Everyone deny and
 * leaves the existing mandatory label untouched. A pre-existing legacy Low label
 * therefore remains until the private temp directory is revoked and removed.
 *
 * Idempotent: the exact ACE skips SetNamedSecurityInfoW and its eager full-tree
 * propagation. Otherwise read-merge-write preserves pre-existing explicit ACEs.
 * Runs under the per-path lock. The caller needs permission to edit the DACL;
 * no SACL or WRITE_OWNER access is requested.
 * @param api - the binding table.
 * @param path - the directory whose DACL gains the grant.
 * @param sidPtr - the capability SID the ACE names.
 */
export function grantWrite(api: Win32Bindings, path: string, sidPtr: NativePtr): void {
  withPathLock(api, path, () => {
    const { oldAcl, descriptor } = readCurrentSecurity(api, path, false)
    if (oldAcl !== null && hasExactGrant(oldAcl, sidPtr)) {
      if (descriptor !== null) {
        const freed = api.localFree(descriptor)
        if (!isNullPtr(freed)) throwLastError(api, 'LocalFree', `grantWrite(${path}) descriptor`)
      }
      return
    }
    mergeAndApply(
      api, path, buildExplicitAccess(sidPtr, abi.GRANT_ACCESS, abi.GRANT_MASK), oldAcl,
      { kind: 'keep' }, descriptor, 'grantWrite',
    )
  })
}

/**
 * Deny the capability SID every write right on `path` — the legacy `home-write`
 * exclusion. Idempotent on the exact deny ACE; the mandatory label is untouched.
 * @param api - the binding table.
 * @param path - the excluded directory.
 * @param sidPtr - the capability SID whose write access is denied there.
 */
export function denyWrite(api: Win32Bindings, path: string, sidPtr: NativePtr): void {
  withPathLock(api, path, () => {
    const { oldAcl, descriptor } = readCurrentSecurity(api, path, false)
    if (oldAcl !== null
      && hasExactEntry(oldAcl, abi.ACCESS_DENIED_ACE_TYPE, abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT, abi.GRANT_MASK, sidPtr)) {
      if (descriptor !== null) {
        const freed = api.localFree(descriptor)
        if (!isNullPtr(freed)) throwLastError(api, 'LocalFree', `denyWrite(${path}) descriptor`)
      }
      return
    }
    mergeAndApply(
      api, path, buildExplicitAccess(sidPtr, abi.DENY_ACCESS, abi.GRANT_MASK), oldAcl,
      { kind: 'keep' }, descriptor, 'denyWrite',
    )
  })
}

/**
 * Remove the capability-SID deny ACE {@link denyWrite} added (REVOKE_ACCESS
 * merge for that trustee). Inherited allow ACEs from a granted parent are not
 * explicit on `path`, so they survive this revoke.
 * @param api - the binding table.
 * @param path - the formerly excluded directory.
 * @param sidPtr - the capability SID whose deny is removed.
 * @returns whether a DACL was present to edit.
 */
export function revokeDeny(api: Win32Bindings, path: string, sidPtr: NativePtr): boolean {
  return withPathLock(api, path, () => {
    const { oldAcl, descriptor } = readCurrentSecurity(api, path, false)
    if (oldAcl === null) {
      if (descriptor !== null) {
        const freed = api.localFree(descriptor)
        if (!isNullPtr(freed)) throwLastError(api, 'LocalFree', `revokeDeny(${path}) descriptor`)
      }
      return false
    }
    mergeAndApply(
      api, path, buildExplicitAccess(sidPtr, abi.REVOKE_ACCESS, 0), oldAcl,
      { kind: 'keep' }, descriptor, 'revokeDeny',
    )
    return true
  })
}

/**
 * Remove every ACE for the capability SID from the directory DACL. The legacy
 * label is restored to Medium only when no other capability grant remains on the directory;
 * a surviving grant retains its earlier label. Returns whether an ACE removal
 * was attempted (false when the directory carries no DACL at all).
 * @param api - the binding table.
 * @param path - the directory whose DACL loses the capability-SID ACEs.
 * @param sidPtr - the capability SID whose ACEs are removed.
 * @returns whether an ACE removal was attempted (false when the directory carries no DACL at all).
 */
export function revokeWrite(api: Win32Bindings, path: string, sidPtr: NativePtr): boolean {
  return withPathLock(api, path, () => {
    const { oldAcl, descriptor } = readCurrentSecurity(api, path, true)
    if (oldAcl === null) {
      if (descriptor !== null) {
        const freed = api.localFree(descriptor)
        if (!isNullPtr(freed)) throwLastError(api, 'LocalFree', `revokeWrite(${path}) descriptor`)
      }
      return false
    }
    const foreign = hasForeignGrant(oldAcl, sidPtr)
    mergeAndApply(
      api, path, buildExplicitAccess(sidPtr, abi.REVOKE_ACCESS, 0), oldAcl,
      foreign ? { kind: 'keep' } : { kind: 'medium', acl: buildMediumLabelAcl(api) },
      descriptor, 'revokeWrite',
    )
    return true
  })
}
