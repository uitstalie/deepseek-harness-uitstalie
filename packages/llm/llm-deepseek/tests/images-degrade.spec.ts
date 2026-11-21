/** Messages request behavior when a retained image's attachment bytes are gone. */
import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment/types'
import { AttachmentError, type ImageAttachmentRef, type RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { resolveAdapterOptions } from '../src/config.ts'
import { prepareImages } from '../src/images.ts'
import { requestImageStore, user } from './helpers.ts'

const present: ImageAttachmentRef = {
  attachmentId: brandString<AttachmentId>(`sha256:${'a'.repeat(64)}`), width: 1, height: 1, mediaType: 'image/png', bytes: 3,
}
const missing: ImageAttachmentRef = {
  attachmentId: brandString<AttachmentId>(`sha256:${'b'.repeat(64)}`), width: 1, height: 1, mediaType: 'image/png', bytes: 3,
}
const version = (attachment: ImageAttachmentRef): RequestImageAttachment => ({
  attachment, variantId: brandString<ImageVariantId>(`sha256:${'c'.repeat(64)}`),
  data: Uint8Array.of(1, 2, 3), bytes: 3, mediaType: 'image/png', width: 1, height: 1, depth: 'uchar', space: 'srgb', hasAlpha: false,
})
const messages = (refs: readonly ImageAttachmentRef[]) => [{ ...user(), content: refs.map(ref => ({ type: 'image' as const, attachment: ref })) }]

function store(missingIds: ReadonlySet<string>, failure: 'missing' | 'corrupt' = 'missing') {
  return requestImageStore(vi.fn(async (attachment: ImageAttachmentRef) => {
    if (!missingIds.has(attachment.attachmentId)) return version(attachment)
    throw failure === 'missing'
      ? new AttachmentError('Attachment object is missing.', 'ATTACHMENT_NOT_FOUND')
      : new AttachmentError('Stored attachment failed integrity verification.', 'ATTACHMENT_CORRUPT')
  }))
}

const prepare = (refs: readonly ImageAttachmentRef[], attachments: ReturnType<typeof store>) =>
  prepareImages(messages(refs), resolveAdapterOptions({}), 'deepseek-flash', attachments,
    () => ({ readonlyPath: '/workspace/image.png' }), new AbortController().signal)

describe('missing retained images', () => {
  it('replaces only the reference whose bytes are gone and keeps the readable one', async () => {
    const prepared = await prepare([present, missing], store(new Set([missing.attachmentId])))
    expect([...prepared.versions.keys()]).toEqual([present.attachmentId])
    expect(prepared.messages[0]?.content).toMatchObject([
      { type: 'image', attachment: present },
      { type: 'text', text: `[image unavailable: attachment ${missing.attachmentId} is missing from the attachment store]` },
    ])
  })

  it('keeps a request whose images are all gone rather than failing the turn', async () => {
    const prepared = await prepare([missing], store(new Set([missing.attachmentId])))
    expect(prepared.versions.size).toBe(0)
    expect(prepared.messages[0]?.content).toEqual([
      { type: 'text', text: `[image unavailable: attachment ${missing.attachmentId} is missing from the attachment store]` },
    ])
  })

  it('still fails the request on a damaged attachment object', async () => {
    await expect(prepare([missing], store(new Set([missing.attachmentId]), 'corrupt')))
      .rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
  })

  it('still fails the request on a store that reports nothing for the reference', async () => {
    const attachments = requestImageStore(vi.fn(async () => { throw new Error('unexpected store failure') }))
    await expect(prepare([present], attachments)).rejects.toThrow('unexpected store failure')
  })
})
