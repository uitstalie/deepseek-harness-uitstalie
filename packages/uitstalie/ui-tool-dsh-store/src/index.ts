/**
 * Node half of the sidebar rules plugin.
 *
 * The rules button reads a workspace's `.dsh` rules through the store's Remote
 * namespace; nothing here registers a Host capability, so the node half is an
 * empty body that keeps the package's two-entry structure.
 */

/** Host plugin body — all behavior lives in the browser half. */
export function apply(): void {}
