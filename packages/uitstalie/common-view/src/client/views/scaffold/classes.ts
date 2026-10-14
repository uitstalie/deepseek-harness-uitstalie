/**
 * Class-name joining shared by the scaffold's replicas.
 * @module @deepseek-ai/dsh-client-common-view/classes
 */

/**
 * Join the classes a replica draws with, dropping the absent ones.
 * @param parts - class names, or the falsy values that drop them.
 * @returns the class attribute value.
 */
export function classes(...parts: readonly (string | false | undefined)[]): string {
  return parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join(' ')
}
