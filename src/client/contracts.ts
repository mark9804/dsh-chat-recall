/** Narrow, type-only Client contracts verified against the installed DSH services.
 * No browser dependency is bundled: the host module table provides React.
 */
export type Dispose = () => void;

export interface ReactElement {
  readonly type: unknown;
  readonly props: unknown;
  readonly key: string | null;
}
export type ReactNode =
  | ReactElement
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly ReactNode[];
export type StateSetter<T> = (value: T | ((previous: T) => T)) => void;
export interface ReactRuntime {
  createElement(
    type: string,
    props: Readonly<Record<string, unknown>> | null,
    ...children: ReactNode[]
  ): ReactElement;
  createElement<P>(type: (props: P) => ReactNode, props: P, ...children: ReactNode[]): ReactElement;
  useState<T>(initial: T | (() => T)): [T, StateSetter<T>];
  useMemo<T>(factory: () => T, dependencies: readonly unknown[]): T;
  useEffect(effect: () => void | Dispose, dependencies: readonly unknown[]): void;
  useRef<T>(initial: T): { current: T };
  useId(): string;
  useSyncExternalStore<T>(subscribe: (listener: Dispose) => Dispose, getSnapshot: () => T): T;
}

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
/** Metadata-only slices of SessionListSnapshot, provided by the standard Slot hook.
 * Verified against DSH 0.2.1-rc.5 ui-session (root hooks.sessions = sessions.list),
 * api-session-controller's buildListSnapshot, and ui-renderer's selector binding.
 * No Session is retained, opened, or searched for message content by this hook.
 */
export interface SessionListItem {
  readonly sessionId: string;
  readonly title?: string;
  readonly cwd?: string;
  readonly origin?: 'subagent';
}
export interface SessionListSnapshot {
  readonly items: readonly SessionListItem[];
  readonly state: 'idle' | 'loading' | 'error';
  readonly phase: 'pending' | 'ready';
  readonly error: unknown | null;
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
      component: (props: SettingsSectionProps) => ReactNode,
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
    factory(require: (id: 'react') => ReactRuntime): ClientPlugin;
  }): void;
}

declare global {
  interface Window {
    __ModuleLoader__: ModuleLoader;
  }
}
