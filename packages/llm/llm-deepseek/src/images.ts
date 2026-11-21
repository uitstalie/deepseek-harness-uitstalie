/** Deterministic Messages image preparation for Files references and bounded inline fallback. */

import type { AttachmentStore, ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { contentHasImage, IMAGE_OFFLOAD_REQUIRED_CODE, LlmError, offloadedImageText, projectOffloadedImages, requiredImageOffload } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ImageAttachmentAccessResolver, RequestMessage } from '@deepseek-ai/dsh-llm'
import type { DeepSeekConnectionOptions as Connection } from './types.ts'
import { resolveRequestImageTarget } from './request-pricing.ts'
import type { DeepSeekFileId } from './file-id.ts'
import type { RequestFiles } from './request-files.ts'

export { deepSeekImageRequestPricing as imagePricing } from './request-pricing.ts'

function bounds(connection: Connection, representation: 'raw' | 'base64') {
  return {
    representation,
    maxBytes: representation === 'raw' ? connection.maxRequestFilesBytes : connection.maxInlineRequestImageBytes,
    maxImages: connection.maxImagesPerRequest,
    byteQuantum: representation === 'raw' ? connection.imageOffloadByteQuantum : connection.inlineImageOffloadByteQuantum,
    countQuantum: connection.imageOffloadCountQuantum,
  }
}

function* imageRefs(blocks: readonly ContentBlock[]): Generator<ImageAttachmentRef> {
  for (const block of blocks) {
    if (block.type === 'image') yield block.attachment
  }
}

/**
 * Decide whether a retained reference lost its stored bytes.
 *
 * A durable history can outlive the attachment store's objects, for example after a recovery restored Session logs
 * without the attachments directory. The request then has no bytes to send, and only that reference is unusable.
 * The attachment contract names `ATTACHMENT_NOT_FOUND` for a missing object, and other attachment failures stay fatal.
 * @param error - failure raised while reading one request image.
 * @returns whether the attachment store no longer holds the object.
 */
function isMissingAttachment(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ATTACHMENT_NOT_FOUND'
}

/**
 * Replace the retained image blocks whose bytes are gone with a stable text placeholder.
 * @param messages - projected history that still references the missing attachments.
 * @param missing - attachment ids the store no longer holds.
 * @returns history without those image blocks; other blocks keep their order and content.
 */
function degradeMissingImages(
  messages: readonly RequestMessage[], missing: ReadonlySet<ImageAttachmentRef['attachmentId']>,
): readonly RequestMessage[] {
  return messages.map((message) => {
    const absent = message.content.some(block => block.type === 'image' && missing.has(block.attachment.attachmentId))
    if (!absent) return message
    return {
      ...message,
      content: message.content.map((block): ContentBlock => block.type === 'image' && missing.has(block.attachment.attachmentId)
        ? { type: 'text', text: `[image unavailable: attachment ${String(block.attachment.attachmentId)} is missing from the attachment store]` }
        : block),
    }
  })
}

/** Normalize retained image references before converting Messages content.
 * @param history - durable history; never mutated.
 * @param connection - request-local image budgets.
 * @param modelId - target model id.
 * @param attachments - mounted attachment store, required only for image requests.
 * @param access - current execution-world path resolver.
 * @param signal - request cancellation.
 * @returns projected history and prepared image bytes keyed by attachment id.
 */
export async function prepareImages(
  history: readonly RequestMessage[], connection: Connection, modelId: string,
  attachments: AttachmentStore | undefined, access: ImageAttachmentAccessResolver, signal: AbortSignal,
): Promise<{ messages: readonly RequestMessage[]; versions: Map<ImageAttachmentRef['attachmentId'], RequestImageAttachment> }> {
  const versions = new Map<ImageAttachmentRef['attachmentId'], RequestImageAttachment>()
  let messages = projectOffloadedImages(history, ref => offloadedImageText(ref, access(ref)))
  if (!messages.some(message => contentHasImage(message.content))) return { messages, versions }
  const model = connection.models.find(entry => entry.id === modelId)
  if (model?.inputModalities?.includes('image') !== true || attachments === undefined) {
    throw new LlmError('DeepSeek Messages image input requires a vision model and attachment service', 'UNSUPPORTED_CONTENT')
  }
  if (messages.some(message => message.role !== 'user' && message.role !== 'tool' && contentHasImage(message.content))) {
    throw new LlmError('DeepSeek Messages supports images only in user messages and tool results', 'UNSUPPORTED_CONTENT')
  }
  const missing = new Set<ImageAttachmentRef['attachmentId']>()
  for (const message of messages) {
    for (const ref of imageRefs(message.content)) {
      if (versions.has(ref.attachmentId) || missing.has(ref.attachmentId)) continue
      try {
        versions.set(ref.attachmentId, await attachments.readImageRequest(ref, resolveRequestImageTarget(model, ref), signal))
      } catch (error) {
        if (!isMissingAttachment(error)) throw error
        missing.add(ref.attachmentId)
      }
    }
  }
  if (missing.size > 0) messages = degradeMissingImages(messages, missing)
  assertImagesFit(messages, versions, connection, 'raw')
  return { messages, versions }
}

/** Require logged offload before retrying images that exceed the inline budget.
 * @param messages - history already within the Files budget.
 * @param versions - normalized versions prepared for retained references.
 * @param connection - resolved inline bounds.
 * @returns unchanged history within both byte and image-count limits.
 */
export function inlineImages(
  messages: readonly RequestMessage[], versions: ReadonlyMap<ImageAttachmentRef['attachmentId'], RequestImageAttachment>,
  connection: Connection,
): readonly RequestMessage[] {
  assertImagesFit(messages, versions, connection, 'base64')
  return messages
}

/** Count additional oldest occurrences requiring durable offload at their exact represented bytes. */
function assertImagesFit(
  messages: readonly RequestMessage[], versions: ReadonlyMap<ImageAttachmentRef['attachmentId'], RequestImageAttachment>,
  connection: Connection, representation: 'raw' | 'base64',
): void {
  const offloadImages = requiredImageOffload(messages, bounds(connection, representation),
    block => (versions.get(block.attachment.attachmentId) as RequestImageAttachment).bytes)
  if (offloadImages > 0) {
    throw new LlmError(
      `DeepSeek Messages ${representation} request images exceed the route budget; ${offloadImages} more oldest occurrence(s) must be offloaded.`,
      IMAGE_OFFLOAD_REQUIRED_CODE,
      { offloadImages },
    )
  }
}

/** Resolve retained images to Files ids, recording every occurrence for failure diagnostics.
 * @param messages - history within the Files byte/count budget.
 * @param versions - normalized versions for every retained reference.
 * @param files - request-owned Files resolution and recovery.
 * @returns ids keyed by durable attachment identity.
 */
export async function prepareFileIds(
  messages: readonly RequestMessage[], versions: ReadonlyMap<ImageAttachmentRef['attachmentId'], RequestImageAttachment>, files: RequestFiles,
): Promise<Map<ImageAttachmentRef['attachmentId'], DeepSeekFileId>> {
  const ids = await files.resolveAll(versions)
  for (const [index, message] of messages.entries()) {
    let image = 0
    for (const ref of imageRefs(message.content)) {
      const version = versions.get(ref.attachmentId) as RequestImageAttachment
      files.record(version, ids.get(ref.attachmentId) as DeepSeekFileId, { message: index + 1, image: ++image })
    }
  }
  return ids
}
