/**
 * Command UI plugin, browser half: CommandUiRuntime (`ctx.commandUi`) owning the
 * capability-keyed directory cache, the '/' command source, the client
 * contribution registry, and the per-session popupSelect controllers; the
 * popupSelect shell self-registers into conversation.input.overlay with
 * per-session resolution.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import { IconListPenOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pulls the 'conversation.input.overlay' SlotMap declaration (the
// key's owner) into this program so the overlay registration below typechecks
// against the real declaration — no runtime edge to ui-conversation.
import type { InputTriggerHit } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { CommandUiRuntime } from './service.ts'
import { COMMANDS_PANEL, ComposerMenuRuntime } from './composer-menu.ts'
import { ComposerMenuView, type ComposerMenuInjected } from './ComposerMenuView.tsx'
import type { PopupSelectInjected } from './PopupSelectView.tsx'
import { PopupSelectView } from './PopupSelectView.tsx'
import { en, zh, type CommandKey } from './locales.ts'

export { CommandUiRuntime } from './service.ts'
export { ComposerMenuRuntime, ComposerMenuController, filteredComposerRows, FILE_ACTION, COMMANDS_PANEL, SKILLS_PANEL, CONNECTORS_PANEL } from './composer-menu.ts'
export type { ComposerMenuActionContribution, ComposerMenuContext, ComposerMenuNavItem, ComposerMenuPanelAction, ComposerMenuPanelContribution, ComposerMenuPanelData, ComposerMenuRow, ComposerMenuState } from './composer-menu.ts'
export type { ComposerMenuInjected, ComposerMenuViewProps } from './ComposerMenuView.tsx'
export { CommandDirectory } from './directory.ts'
export type { CommandDescriptor, DirectoryStatus } from './directory.ts'
export { filterOptions, PopupSelectController } from './popup.ts'
export type { PopupSelectDeps, PopupSpec, PopupState, TokenSegment } from './popup.ts'
export type { PopupSelectInjected, PopupSelectViewProps } from './PopupSelectView.tsx'
export type {
  ActionSpec, CommandContribution, CommandDecoration, CommandUiContract, CommandUiSpec, PopupSelectSpec,
  SelectConfirmation, SelectOption,
} from './contract.ts'
export type { CommandKey } from './locales.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    commandUi: CommandUiRuntime
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The menu rows' and the popupSelect shell's copy. */
    command: CommandKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'command'

/** Required services: the '/' source registry, session scopes, commands Remote, and locale registry. */
export const inject = ['inputTriggers', 'sessions', 'remote', 'remote.commands', 'locale']

/**
 * Mount the command service and its per-session popupSelect overlay.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-commands: dictionaries')
  ctx.plugin(CommandUiRuntime)
  ctx.plugin(ComposerMenuRuntime)
  ctx.inject(['slots', 'composerMenu', 'sessions'], (scope: ClientContext) => {
    const composerMenu = scope.get('composerMenu') as ComposerMenuRuntime
    scope.slots.inject('conversation.input.overlay', () => scope.slots.register({
      name: 'conversation.input.overlay',
      id: 'composer-menu',
      order: 0,
      locale: NS,
      inject: (sessionId): ComposerMenuInjected => ({
        composerMenu: composerMenu.controllerFor(sessionId),
      }),
    }, ComposerMenuView))
  })

  ctx.inject(['composerMenu', 'commandUi', 'inputTriggers', 'sessions', 'locale'], (scope: ClientContext) => {
    const composerMenu = scope.get('composerMenu') as ComposerMenuRuntime
    const command = scope.get('commandUi') as CommandUiRuntime
    const inputTriggers = scope.get('inputTriggers') as { sessionOf(actx: ClientContext): { invokeCandidate(source: string, candidate: { name: string; value?: string }, hit: InputTriggerHit, action?: 'pick' | 'drill'): boolean } }
    const sessions = scope.get('sessions') as ISessions
    const t = scope.locale.bind(NS)
    scope.effect(() => composerMenu.registerPanel({
      id: COMMANDS_PANEL,
      label: () => t('section.commands'),
      icon: IconListPenOutlineRegular,
      order: 10,
      async load({ session }, signal) {
        const rows = await command.composerRows(session, signal)
        return {
          searchPlaceholder: t('search.placeholder'),
          emptyText: t('composer.empty'),
          rows: rows.filter(row => row.name !== 'file').map(row => ({
            id: row.name,
            label: row.label ?? row.name,
            ...(row.description === undefined ? {} : { description: row.description }),
            ...(typeof row.icon === 'function' ? { icon: row.icon } : {}),
            ...(row.section === undefined ? {} : { section: row.section }),
            onSelect: ({ session, hit }) => {
              const actx = sessions.scope(session.sessionId)
              if (actx === undefined) throw new Error('command composer: session scope unavailable')
              const applied = inputTriggers.sessionOf(actx).invokeCandidate('command', {
                name: row.name,
                ...(row.value === undefined ? {} : { value: row.value }),
              }, hit, 'pick')
              if (!applied) throw new Error(`command composer: /${row.name} was not applied`)
            },
          })),
        }
      },
    }), 'composerMenu: commands panel')
  })

  ctx.inject(['slots', 'commandUi', 'sessions'], (scope: ClientContext) => {
    const command = scope.commandUi
    const sessions = scope.get('sessions') as ISessions
    scope.slots.inject('conversation.input.overlay', () => scope.slots.register({
      name: 'conversation.input.overlay',
      id: 'command-popup',
      order: 1,
      locale: NS,
      inject: (sessionId): PopupSelectInjected => {
        const actx = sessions.scope(sessionId)
        if (actx === undefined) throw new Error(`ui-commands: session "${String(sessionId)}" resolved no scope`)
        return { popup: command.popupFor(actx) }
      },
    }, PopupSelectView))
  })
}
