/**
 * PKCE（RFC 7636）工具：Web Crypto 生成 verifier/challenge（S256）。
 * 移植 pi-ai 的 pkce.js（跨 Node/浏览器兼容）。
 *
 * @module @deepseek-ai/dsh-llm-plus/oauth/pkce
 */

/** base64url 编码（去 padding）。 */
function base64urlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

/** 生成 PKCE code verifier 与 S256 challenge。 */
export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = new Uint8Array(32)
  crypto.getRandomValues(verifierBytes)
  const verifier = base64urlEncode(verifierBytes)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return { verifier, challenge: base64urlEncode(new Uint8Array(digest)) }
}
