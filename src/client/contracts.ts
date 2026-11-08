import type { ComponentType } from 'react';

/** Narrow public Client contracts verified against the installed DSH services.
 * React/ReactDOM are provided by the host; Base UI is bundled in the Client only.
 */
export type Dispose = () => void;

export interface Observable<T> {
  getSnapshot(): T;
  subscribe(listener: Dispose): Dispose;
}
export interface SettingsDescriptor {
  ns: string;
  value: unknown;
  revision: number;
}
export interface DescribeSnapshot {
  status: 'idle' | 'loading' | 'ready';
  view?: {
    namespaces: readonly SettingsDescriptor[];
    writable: boolean;
  };
  error: string | null;
}
export interface DescribeMirror extends Observable<DescribeSnapshot> {
  ensure(): Promise<void>;
  load(): Promise<void>;
}
export interface FormSnapshot {
  status: 'loading' | 'ready' | 'unavailable';
  value: unknown;
  revision: number | undefined;
  writable: boolean;
}
export type SettingsPathOp =
  | { op: 'set'; path: readonly string[]; value: unknown }
  | { op: 'unset'; path: readonly string[] };
export interface ConfigForm extends Observable<FormSnapshot> {
  mutate(ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<boolean>;
}
export interface LocaleSnapshot {
  active: string;
  revision: number;
}
export interface LocaleService extends Observable<LocaleSnapshot> {
  register(
    namespace: string,
    dictionaries: { en: Record<string, string>; zh: Record<string, string> },
  ): Dispose;
  bind(namespace: string): (key: string, parameters?: Record<string, string | number>) => string;
}
/** Metadata-only slice of the PUBLIC ClientSessions.list store (DSH 0.2.1-rc.5).
 * ui-session provides this store as useSessions. ClientSessions.projectList maps
 * internal manager items/sessionId into ids/byId rows with id/displayTitle.
 * The public store does NOT expose the manager's items/state/error fields.
 * No Session is retained, opened, or searched for message content by this hook.
 */
export interface SessionListItem {
  readonly id: string;
  readonly displayTitle: string;
  readonly title?: string;
  readonly cwd?: string;
  readonly origin?: 'subagent';
}
export interface SessionListSnapshot {
  readonly ids: readonly string[];
  readonly byId: Readonly<Record<string, SessionListItem | undefined>>;
  readonly phase: 'pending' | 'ready';
}
export interface UseSessions {
  <T>(selector: (snapshot: SessionListSnapshot) => T, equal?: (a: T, b: T) => boolean): T;
}
export interface SettingsSectionProps {
  readonly useSessions: UseSessions;
}
export interface ClientContext {
  effect(effect: () => Dispose, label?: string): Dispose;
  locale: LocaleService;
  configForms: {
    describe(): DescribeMirror;
    get(entryId: string): ConfigForm;
  };
  slots: {
    inject(ownerKey: 'settings.section', register: () => Dispose): Dispose;
    register(
      options: {
        name: 'settings.section';
        id: 'chat-recall';
        order: number;
        label: () => string;
        locale: 'chat-recall';
      },
      component: ComponentType<SettingsSectionProps>,
    ): Dispose;
  };
}
export interface ClientPlugin {
  inject: readonly ['slots', 'locale', 'configForms'];
  apply(ctx: ClientContext): void;
}
export interface ModuleLoader {
  load(module: {
    id: 'dsh-chat-recall';
    factory(require: (id: string) => unknown): ClientPlugin;
  }): void;
}

declare global {
  interface Window {
    __ModuleLoader__: ModuleLoader;
  }
}
