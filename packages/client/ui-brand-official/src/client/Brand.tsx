import { BrandLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the official mark with the presentation requested by its host surface.
 * @param props - Host-supplied mark presentation.
 * @returns the official 维小智 mark.
 */
export function OfficialBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return <BrandLogo size={size} />
}

/**
 * Render the official name without its independently slotted mark.
 * @returns the official brand name.
 */
export function OfficialBrandName() {
  return <span style={{ fontSize: 15, fontWeight: 650, letterSpacing: '-0.2px' }}>维小智</span>
}
