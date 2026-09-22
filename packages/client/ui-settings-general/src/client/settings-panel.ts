/** Root-owned settings panel opener for feature entry points. */
import { Service, type Context } from '@deepseek-ai/cordis'

/** Request the settings shell open one section, or its default section when omitted. */
export interface SettingsPanelController {
  open(sectionId?: string): void
  register(listener: (sectionId?: string) => void): () => void
}

/** Coordinates feature requests with the mounted settings shell. */
export class SettingsPanelService extends Service implements SettingsPanelController {
  private readonly listeners = new Set<(sectionId?: string) => void>()

  constructor(ctx: Context) {
    super(ctx, 'settingsPanel')
  }

  open(sectionId?: string): void {
    for (const listener of this.listeners) listener(sectionId)
  }

  register(listener: (sectionId?: string) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    settingsPanel: SettingsPanelController
  }
}
