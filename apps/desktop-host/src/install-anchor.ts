/** Installation manifest that owns module resolution for the Desktop profile. */

import { join } from 'node:path'

/**
 * Resolve the manifest the Desktop Host anchors profile resolution on.
 *
 * fork: the Desktop installation is the runtime project, not `@deepseek-ai/dsh`.
 * The runtime project manifest declares the union of the dsh and Desktop Host
 * closures, so bundled profile layers that dsh alone does not depend on stay
 * inside the installation module fallback: anchoring on dsh dropped
 * `@deepseek-ai/dsh-plugin-enterprise` and `dsh-context` from every resolution
 * generation, and both then failed to import during `runtime` resolution.
 * @param runtimeDir - immutable application package directory supplied by Electron.
 * @returns absolute path of the runtime project manifest.
 */
export function desktopInstallAnchor(runtimeDir: string): string {
  return join(runtimeDir, 'package.json')
}
