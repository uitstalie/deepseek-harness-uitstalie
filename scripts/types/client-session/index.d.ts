/**
 * Client compile-face augmentation: the one `sessions` service carries both the
 * Host `SessionStore` surface and the client `ISessions` object layer.
 *
 * Host projects include the real `Context.sessions: SessionStore` declaration;
 * this file is loaded only through the client `types` array, so the two faces
 * stay separate while sharing the same property name.
 */
import type { ISessions } from '../../../packages/api/session-controller/src/client/contract/sessions.ts'

declare module '@deepseek-ai/dsh-session' {
  interface SessionStore extends ISessions {}
}
