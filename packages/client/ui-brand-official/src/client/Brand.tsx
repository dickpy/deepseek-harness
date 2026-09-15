import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { BrandLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

/** Electron 壳暴露的产品版本（见 apps/desktop/src/preload-app.ts）。 */
declare global {
  interface Window {
    dshDesktop?: {
      appVersion?: () => Promise<string>
    }
  }
}

/**
 * 版本徽章：沿用 ui-sidebar 里 `.buildVersion` 的观感（反色小标签、等宽字体）。
 * 那个徽章在正式包里被本包的 name slot 盖住，所以这里按同一个设计重新给出，
 * 尺寸随品牌名的 15px 字号放大到可读。
 */
const VERSION_BADGE: CSSProperties = {
  flex: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  height: 16,
  padding: '0 4px',
  borderRadius: 4,
  color: 'var(--dsw-alias-label-primary-inverted)',
  background: 'var(--dsw-alias-label-primary)',
  fontFamily: 'var(--ds-font-family-code)',
  fontSize: 10,
  fontWeight: 500,
  lineHeight: '16px',
  letterSpacing: 0,
}

/**
 * Read the running desktop release.
 *
 * Undefined in the browser build, which has no shell to ask, and until the
 * desktop shell answers. A missing version only costs the badge; the brand
 * mark and name still render, so a failure to read is not surfaced.
 * @returns Product version, or undefined when it is unavailable yet.
 */
function useAppVersion(): string | undefined {
  const [version, setVersion] = useState<string>()
  useEffect(() => {
    let active = true
    void window.dshDesktop?.appVersion?.().then(
      (value) => { if (active) setVersion(value) },
      () => { /* 版本号是辅助信息；读不到就不显示徽章。 */ },
    )
    return () => { active = false }
  }, [])
  return version
}

/**
 * Render the official mark with the presentation requested by its host surface.
 * @param props - Host-supplied mark presentation.
 * @returns the official 维小智 mark.
 */
export function OfficialBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return <BrandLogo size={size} />
}

/**
 * Render the official name and the running release beside it.
 *
 * 版本号紧跟品牌名显示：用户报障时最先被问到的就是「你装的是哪个版本」，
 * 而正式包里上游那段版本徽章不会渲染，见本包 index.ts 对 name slot 的占用。
 * @returns the official brand name with its version badge.
 */
export function OfficialBrandName() {
  const version = useAppVersion()
  return (
    <>
      <span style={{ fontSize: 15, fontWeight: 650, letterSpacing: '-0.2px' }}>维小智</span>
      {version !== undefined && version !== '' && <span style={VERSION_BADGE}>{version}</span>}
    </>
  )
}
