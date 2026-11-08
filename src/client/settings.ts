import type { ClientContext } from './contracts.js';
import { createSettingsPage } from './SettingsPage.js';
import { en, zh } from './locale.js';

/** Build wraps this module in the DSH factory; React/ReactDOM stay Host-owned. */
export const inject = ['slots', 'locale', 'configForms'] as const;

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('chat-recall', { en, zh }));
  const t = ctx.locale.bind('chat-recall');
  const SettingsPage = createSettingsPage(ctx);
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'chat-recall',
        order: 35,
        label: () => t('title'),
        locale: 'chat-recall',
      },
      SettingsPage,
    ),
  );
}
