import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { JSDOM } from 'jsdom';
import * as React from 'react';
import type { ComponentType } from 'react';
import type {
  ClientContext,
  ClientPlugin,
  ConfigForm,
  DescribeSnapshot,
  FormSnapshot,
  SessionListSnapshot,
  SettingsPathOp,
  SettingsSectionProps,
  UseSessions,
} from '../src/client/contracts.js';
import type { Configuration } from '../src/client/model.js';

// Actual bundled React/Base UI components in a synthetic DOM with explicit service
// fixtures. This is interaction regression, NOT DSH/browser layout verification.
const dom = new JSDOM('<!doctype html><html><body><div id="test-root"></div></body></html>', {
  pretendToBeVisual: true,
  runScripts: 'outside-only',
  url: 'http://synthetic.invalid',
});
// jsdom 26 lacks PointerEvent, which Base UI uses even for click activation.
// This test-only shim is not application code or browser compatibility evidence.
class SyntheticPointerEvent extends dom.window.MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly isPrimary: boolean;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? 'mouse';
    this.isPrimary = init.isPrimary ?? true;
  }
}
Object.defineProperty(dom.window, 'PointerEvent', {
  configurable: true,
  value: SyntheticPointerEvent,
});
for (const name of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLButtonElement',
  'HTMLTextAreaElement',
  'Element',
  'Node',
  'MutationObserver',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: name === 'window' ? dom.window : dom.window[name],
  });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
const { createRoot } = await import('react-dom/client');
const require = createRequire(import.meta.url);
const code = await readFile(new URL('../dist/client/settings.js', import.meta.url), 'utf8');
const config = (patch: Partial<Configuration> = {}): Configuration => ({
  nodePath: 'node',
  dataPath: '/synthetic/recall',
  sessionIds: [],
  embeddingSessionIds: [],
  callerSessionIds: [],
  autoSync: true,
  autoEmbed: false,
  dominantMin: 0.5,
  dominantGap: 0.15,
  ...patch,
});
const element = <T extends Element>(root: ParentNode, selector: string): T => {
  const found = root.querySelector<T>(selector);
  assert.ok(found, selector);
  return found;
};
function store<T>(snapshot: T) {
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(next: T) {
      snapshot = next;
      for (const listener of listeners) listener();
    },
  };
}

async function mount(
  base: unknown = config(),
  options: { writable?: boolean; reject?: boolean; ambiguous?: boolean; catalogSize?: number } = {},
) {
  const writable = options.writable ?? true;
  const ns = 'include:dsh-chat-recall';
  const formStore = store<FormSnapshot>({ status: 'ready', value: base, revision: 7, writable });
  const directory = store<DescribeSnapshot>({
    status: 'ready',
    error: null,
    view: {
      writable,
      namespaces: [
        { ns, value: base, revision: 7 },
        ...(options.ambiguous ? [{ ns: 'other:dsh-chat-recall', value: base, revision: 7 }] : []),
      ],
    },
  });
  const ids = Array.from({ length: options.catalogSize ?? 2 }, (_, i) => `session-${i}`);
  const sessions = store<SessionListSnapshot>({
    phase: 'ready',
    ids,
    byId: Object.fromEntries(
      ids.map((id, i) => [id, { id, displayTitle: `Conversation ${i}`, cwd: '/synthetic' }]),
    ),
  });
  const useSessions: UseSessions = (selector, _equal) =>
    selector(React.useSyncExternalStore(sessions.subscribe, sessions.getSnapshot));
  const locale = store({ active: 'en', revision: 0 });
  const dictionaries = new Map<
    string,
    { en: Record<string, string>; zh: Record<string, string> }
  >();
  let ensures = 0,
    loads = 0;
  const mutations: { ops: readonly SettingsPathOp[]; revision: number | undefined }[] = [];
  const form: ConfigForm = {
    ...formStore,
    async mutate(ops, revision) {
      mutations.push({ ops, revision });
      if (options.reject || revision !== formStore.getSnapshot().revision) return false;
      const value = { ...(formStore.getSnapshot().value as Configuration) } as Record<
        string,
        unknown
      >;
      for (const op of ops) {
        if (op.op === 'set') value[op.path[0]!] = op.value;
        else delete value[op.path[0]!];
      }
      const next = (revision ?? 0) + 1;
      formStore.publish({ status: 'ready', value, revision: next, writable });
      directory.publish({
        status: 'ready',
        error: null,
        view: { writable, namespaces: [{ ns, value, revision: next }] },
      });
      return true;
    },
  };
  let page: ComponentType<SettingsSectionProps> | undefined;
  let plugin: ClientPlugin | undefined;
  const cleanup: Array<() => void> = [];
  const ctx: ClientContext = {
    effect(install) {
      const dispose = install();
      cleanup.push(dispose);
      return dispose;
    },
    locale: {
      ...locale,
      register(namespace, dicts) {
        dictionaries.set(namespace, dicts);
        return () => {
          dictionaries.delete(namespace);
        };
      },
      bind(namespace) {
        return (key, params) => {
          let text =
            dictionaries.get(namespace)?.[locale.getSnapshot().active === 'zh' ? 'zh' : 'en'][
              key
            ] ?? key;
          for (const [name, value] of Object.entries(params ?? {}))
            text = text.replaceAll(`{${name}}`, String(value));
          return text;
        };
      },
    },
    configForms: {
      describe: () => ({
        ...directory,
        async ensure() {
          ensures++;
        },
        async load() {
          loads++;
        },
      }),
      get: () => form,
    },
    slots: {
      inject(_owner, install) {
        return install();
      },
      register(options, component) {
        assert.equal(options.name, 'settings.section');
        assert.equal(options.id, 'chat-recall');
        page = component;
        return () => {
          page = undefined;
        };
      },
    },
  };
  Object.assign(dom.window, {
    __ModuleLoader__: {
      load(registration: { id: string; factory(require: NodeJS.Require): ClientPlugin }) {
        assert.equal(registration.id, 'dsh-chat-recall');
        plugin = registration.factory(require);
      },
    },
  });
  new Script(code).runInContext(dom.getInternalVMContext());
  assert.ok(plugin);
  plugin.apply(ctx);
  assert.ok(page);
  const container = element<HTMLElement>(dom.window.document, '#test-root');
  const root = createRoot(container);
  await React.act(async () => root.render(React.createElement(page!, { useSessions })));
  return {
    container,
    formStore,
    directory,
    mutations,
    sessions,
    locale,
    get ensures() {
      return ensures;
    },
    get loads() {
      return loads;
    },
    async close() {
      await React.act(async () => root.unmount());
      for (const dispose of cleanup.reverse()) dispose();
      assert.equal(container.childElementCount, 0);
    },
  };
}

async function click(node: Element) {
  await React.act(async () => {
    (node as HTMLElement).click();
  });
}
async function input(node: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLInputElement.prototype,
    'value',
  )!.set!;
  await React.act(async () => {
    setter.call(node, value);
    node.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}

// Each test owns and unmounts its root; no component snapshot or fake React runtime.
test('manual embedding permission stays manual until background embedding is confirmed and saved', async () => {
  const ui = await mount(config({ autoSync: false }));
  try {
    assert.equal(ui.ensures, 1);
    const { container, formStore, mutations } = ui;
    const toggle = element<HTMLButtonElement>(container, '[role="switch"][id$="-auto-embed"]');
    const sync = element(container, '[role="switch"][id$="-auto-sync"]');
    const submit = element<HTMLButtonElement>(container, 'button[type="submit"]');
    const outbound = '[role="checkbox"][aria-labelledby$="-confirm-outbound-label"]';
    const persisted = () => formStore.getSnapshot().value as Configuration;
    const groups = container.querySelectorAll('[role="radiogroup"]');

    assert.equal(toggle.disabled, true);
    assert.equal(submit.disabled, true);
    await click(groups[0]!.querySelectorAll('[role="radio"]')[2]!);
    await click(groups[1]!.querySelectorAll('[role="radio"]')[2]!);
    assert.equal(toggle.disabled, true, 'outbound permission alone is not enough');
    await click(sync);
    assert.equal(toggle.disabled, false);
    assert.equal(submit.disabled, true);
    await click(element(container, '[role="checkbox"][aria-labelledby$="-confirm-local-label"]'));
    assert.equal(submit.disabled, true);
    await click(element(container, outbound));
    await click(submit);
    const manual = persisted();
    assert.deepEqual([...manual.sessionIds], ['all']);
    assert.deepEqual([...manual.embeddingSessionIds], ['all']);
    assert.equal(manual.autoSync, true);
    assert.equal(manual.autoEmbed, false);

    const summary = element(container, '.cr-summary');
    const savedSummary = summary.textContent;
    await click(toggle);
    assert.equal(toggle.getAttribute('aria-checked'), 'true');
    assert.equal(submit.disabled, true, 'existing outbound permission does not confirm autoEmbed');
    await click(element(container, outbound));
    assert.equal(persisted().autoEmbed, false, 'confirmation alone does not save');
    assert.equal(summary.textContent, savedSummary, 'the summary shows only saved values');
    await click(submit);
    assert.equal(persisted().autoEmbed, true);
    assert.notEqual(summary.textContent, savedSummary);

    await click(sync);
    assert.equal(toggle.getAttribute('aria-checked'), 'true');
    assert.equal(submit.disabled, true);
    await click(toggle);
    assert.equal(toggle.disabled, true);
    assert.equal(submit.disabled, false, 'stopping background embedding needs no new grant');
    await click(submit);
    const stopped = persisted();
    assert.equal(stopped.autoSync, false);
    assert.equal(stopped.autoEmbed, false);
    assert.deepEqual(
      mutations.map(({ revision }) => revision),
      [7, 8, 9],
    );
  } finally {
    await ui.close();
  }
});

test('real picker keeps missing saved IDs, uses 50-row pages and filters only metadata', async () => {
  const ui = await mount(config({ sessionIds: ['archived'], embeddingSessionIds: [] }), {
    catalogSize: 53,
  });
  try {
    assert.match(ui.container.textContent ?? '', /saved ID retained/);
    const picker = element<HTMLElement>(ui.container, '.cr-picker');
    assert.equal(picker.querySelectorAll('[role="checkbox"]').length, 50);
    const next = [...picker.querySelectorAll('button')].find(
      (button) => button.textContent === 'Next 50',
    );
    assert.ok(next);
    await click(next);
    assert.equal(picker.querySelectorAll('[role="checkbox"]').length, 3);
    await input(element<HTMLInputElement>(picker, 'input[type="search"]'), 'Conversation 52');
    assert.equal(picker.querySelectorAll('[role="checkbox"]').length, 1);
    const control = element<HTMLElement>(picker, '[role="checkbox"]');
    assert.equal(control.getAttribute('aria-checked'), 'false');
    const label = element<HTMLLabelElement>(picker, '.cr-checkbox-label');
    assert.equal(element<HTMLInputElement>(picker, 'input[type="checkbox"]').id, label.htmlFor);
    await click(label);
    assert.equal(
      control.getAttribute('aria-checked'),
      'true',
      'metadata label activates exactly once',
    );
    assert.equal(element<HTMLInputElement>(picker, 'input[type="checkbox"]').checked, true);
    assert.match(ui.container.textContent ?? '', /Selected conversations \(2\)/);
    assert.equal(ui.mutations.length, 0);
  } finally {
    await ui.close();
  }
});

test('mirror refresh cannot overwrite a dirty or rejected draft; rebase retains values and resets grants', async () => {
  const ui = await mount(config(), { reject: true });
  try {
    await click(
      ui.container
        .querySelectorAll('[role="radiogroup"]')[0]!
        .querySelectorAll('[role="radio"]')[2]!,
    );
    await click(element(ui.container, '.cr-confirmations [role="checkbox"]'));
    await click(element(ui.container, 'button[type="submit"]'));
    assert.equal(ui.mutations.length, 1);
    assert.match(ui.container.textContent ?? '', /draft is preserved/);
    await React.act(async () => {
      ui.formStore.publish({
        status: 'ready',
        value: config({ nodePath: '/synthetic/new-node' }),
        revision: 8,
        writable: true,
      });
    });
    assert.equal(
      ui.container
        .querySelectorAll('[role="radiogroup"]')[0]!
        .querySelectorAll('[role="radio"]')[2]!
        .getAttribute('aria-checked'),
      'true',
    );
    const rebase = [...ui.container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Review my draft against the latest revision',
    );
    assert.ok(rebase);
    await click(rebase);
    assert.equal(
      element(ui.container, '.cr-confirmations [role="checkbox"]').getAttribute('aria-checked'),
      'false',
    );
    assert.equal(element<HTMLButtonElement>(ui.container, 'button[type="submit"]').disabled, true);
    const advanced = element(ui.container, '[data-slot="cr-collapsible-trigger"]');
    await click(advanced);
    const node = [...ui.container.querySelectorAll<HTMLInputElement>('input')].find(
      (field) => field.value === 'node',
    );
    assert.ok(node, 'rebase preserves every draft field');
  } finally {
    await ui.close();
  }
});

test('a concurrent mirror revision cannot silently save a dirty draft over newer values', async () => {
  const base = config({ sessionIds: ['all'], embeddingSessionIds: ['all'] });
  const ui = await mount(base);
  try {
    const toggle = element(ui.container, '[role="switch"][id$="-auto-embed"]');
    await click(toggle);
    await click(element(ui.container, '.cr-confirmations [role="checkbox"]'));
    await React.act(async () =>
      ui.formStore.publish({
        status: 'ready',
        value: { ...base, nodePath: '/synthetic/newer' },
        revision: 8,
        writable: true,
      }),
    );
    await click(element(ui.container, 'button[type="submit"]'));
    assert.equal(ui.mutations.length, 1);
    assert.equal(
      ui.mutations[0]!.revision,
      7,
      'never substitutes the newest revision behind a dirty draft',
    );
    const persisted = ui.formStore.getSnapshot().value as Configuration;
    assert.equal(persisted.nodePath, '/synthetic/newer');
    assert.equal(persisted.autoEmbed, false);
    assert.match(ui.container.textContent ?? '', /draft is preserved/);
    assert.equal(toggle.getAttribute('aria-checked'), 'true');
  } finally {
    await ui.close();
  }
});

test('keyboard controls, label associations and disabled actions keep native form semantics', async () => {
  const ui = await mount(config({ sessionIds: ['session-0'] }));
  try {
    const picker = element<HTMLElement>(ui.container, '.cr-picker');
    const checkbox = element<HTMLElement>(picker, '[role="checkbox"]');
    await React.act(async () => {
      checkbox.focus();
      checkbox.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }),
      );
      checkbox.dispatchEvent(
        new dom.window.KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true }),
      );
    });
    assert.equal(checkbox.getAttribute('aria-checked'), 'false');
    assert.equal(ui.mutations.length, 0);
    const radios = ui.container
      .querySelectorAll('[role="radiogroup"]')[0]!
      .querySelectorAll<HTMLElement>('[role="radio"]');
    await React.act(async () => {
      radios[1]!.focus();
    });
    await React.act(async () => {
      radios[1]!.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', {
          key: 'ArrowRight',
          code: 'ArrowRight',
          bubbles: true,
        }),
      );
      radios[1]!.dispatchEvent(
        new dom.window.KeyboardEvent('keyup', {
          key: 'ArrowRight',
          code: 'ArrowRight',
          bubbles: true,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 1));
    });
    assert.equal(dom.window.document.activeElement, radios[2], 'arrow moves the roving focus');
    await React.act(async () => {
      radios[2]!.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }),
      );
      radios[2]!.dispatchEvent(
        new dom.window.KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true }),
      );
    });
    assert.equal(
      radios[2]!.getAttribute('aria-checked'),
      'true',
      'Space activates the focused radio',
    );
    const trigger = element<HTMLElement>(ui.container, '[data-slot="cr-collapsible-trigger"]');
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    await click(trigger);
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    assert.equal(ui.mutations.length, 0, 'disclosure buttons never implicitly submit');
    const node = [...ui.container.querySelectorAll<HTMLInputElement>('input')].find(
      (field) => field.value === 'node',
    );
    assert.ok(node);
    const help = node.getAttribute('aria-describedby');
    assert.ok(help && dom.window.document.getElementById(help));
    assert.ok(
      [...ui.container.querySelectorAll<HTMLLabelElement>('label')].some(
        (label) => label.htmlFor === node.id,
      ),
    );
  } finally {
    await ui.close();
  }
});

test('read-only, ambiguous and old Host settings never mutate; locale updates remain reactive', async () => {
  const current = config({ sessionIds: ['all'], embeddingSessionIds: ['all'], autoEmbed: true });
  const { autoEmbed: _autoEmbed, ...old } = current;
  for (const [value, options] of [
    [current, { writable: false }],
    [current, { ambiguous: true }],
    [old, {}],
  ] as const) {
    const ui = await mount(value, options);
    try {
      const toggle = ui.container.querySelector<HTMLButtonElement>(
        '[role="switch"][id$="-auto-embed"]',
      );
      const submit = ui.container.querySelector<HTMLButtonElement>('button[type="submit"]');
      if ('writable' in options && options.writable === false) {
        assert.ok(toggle?.disabled && submit?.disabled);
        await click(toggle);
        assert.equal(toggle.getAttribute('aria-checked'), 'true');
        await click(submit);
        const heading = element(ui.container, 'h1');
        const title = heading.textContent;
        await React.act(async () => ui.locale.publish({ active: 'zh', revision: 1 }));
        assert.notEqual(heading.textContent, title);
      } else {
        assert.equal(toggle, null);
        assert.equal(submit, null);
      }
      assert.equal(ui.mutations.length, 0);
    } finally {
      await ui.close();
    }
  }
});
