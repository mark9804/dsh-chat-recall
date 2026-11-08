import * as React from 'react';
import type {
  ClientContext,
  DescribeMirror,
  DescribeSnapshot,
  Observable,
  SettingsSectionProps,
} from './contracts.js';
import type { Translate, TextKey } from './locale.js';
import {
  configuration,
  confirmations,
  dirty,
  initial,
  lines,
  operations,
  pickerEntries,
  pickerPage,
  pickerSelections,
  sameCatalog,
  searchEntries,
  sessionCatalog,
  toggleSelection,
  validate,
} from './model.js';
import type {
  CatalogEntry,
  Configuration,
  Draft,
  EditorState,
  PickerPage,
  ScopeDraft,
  SessionCatalog,
} from './model.js';
import {
  Advanced,
  Button,
  Checkbox,
  ChoiceCards,
  Field,
  FieldSet,
  Input,
  Notice,
  Textarea,
  Toggle,
} from './ui.js';
import css from './styles.css';

export function useSnapshot<T>(source: Observable<T>): T {
  const callbacks = React.useMemo(
    () => ({
      subscribe: (listener: () => void) => source.subscribe(listener),
      read: () => source.getSnapshot(),
    }),
    [source],
  );
  return React.useSyncExternalStore(callbacks.subscribe, callbacks.read);
}

function Refresh({
  mirror,
  t,
  disabled = false,
}: {
  mirror: DescribeMirror;
  t: Translate;
  disabled?: boolean;
}) {
  const [loading, setLoading] = React.useState(false);
  const mounted = React.useRef(false);
  const pending = React.useRef(false);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const refresh = async () => {
    if (pending.current) return;
    pending.current = true;
    setLoading(true);
    try {
      await mirror.load();
    } finally {
      pending.current = false;
      if (mounted.current) setLoading(false);
    }
  };
  return (
    <Button disabled={disabled || loading} onClick={() => void refresh().catch(() => undefined)}>
      {t(loading ? 'refreshing' : 'refresh')}
    </Button>
  );
}

function SavedSummary({ value, t }: { value: Configuration; t: Translate }) {
  const scopeText = (ids: string[], embedding: boolean) =>
    ids.includes('all')
      ? t(embedding ? 'embeddingAllSummary' : 'allSummary')
      : ids.length
        ? t('selectedSummary', { count: ids.length })
        : t('off');
  return (
    <section className="cr-summary" aria-label={t('summary')}>
      <h2>{t('summary')}</h2>
      <dl>
        <dt>{t('localScope')}</dt>
        <dd>{scopeText(value.sessionIds, false)}</dd>
        <dt>{t('embeddingScope')}</dt>
        <dd>{scopeText(value.embeddingSessionIds, true)}</dd>
        <dt>{t('syncSummary')}</dt>
        <dd>{t(value.autoSync ? 'on' : 'off')}</dd>
      </dl>
      <p className="cr-muted">{t('summaryNote')}</p>
    </section>
  );
}

export function SessionPicker({
  name,
  value,
  corpus,
  catalog,
  disabled,
  onToggle,
  t,
}: {
  name: 'corpus' | 'embedding';
  value: ScopeDraft;
  corpus?: ScopeDraft;
  catalog: SessionCatalog;
  disabled: boolean;
  onToggle(id: string, checked: boolean): void;
  t: Translate;
}) {
  const id = React.useId();
  const [query, setQuery] = React.useState('');
  const [candidatePage, setCandidatePage] = React.useState(0);
  const [selectedPage, setSelectedPage] = React.useState(0);
  const available = React.useMemo(
    () => pickerEntries(catalog.entries, corpus),
    [catalog.entries, corpus],
  );
  const selected = React.useMemo(
    () => pickerSelections(value, catalog.entries, corpus),
    [value, catalog.entries, corpus],
  );
  const selectedIds = React.useMemo(() => new Set(lines(value.text)), [value.text]);
  const matches = React.useMemo(() => searchEntries(available, query), [available, query]);
  const selectedMatches = React.useMemo(() => searchEntries(selected, query), [selected, query]);
  const candidates = pickerPage(matches, candidatePage);
  const selections = pickerPage(selectedMatches, selectedPage);
  const pagination = (page: PickerPage<unknown>, setPage: (page: number) => void) =>
    page.count ? (
      <div className="cr-picker-pagination">
        <span className="cr-muted" role="status">
          {t('pickerPage', { from: page.from, to: page.to, count: page.count })}
        </span>
        {page.count > 50 && (
          <div className="cr-inline">
            <Button disabled={disabled || !page.hasPrevious} onClick={() => setPage(page.page - 1)}>
              {t('pickerPrevious')}
            </Button>
            <Button disabled={disabled || !page.hasMore} onClick={() => setPage(page.page + 1)}>
              {t('pickerNext')}
            </Button>
          </div>
        )}
      </div>
    ) : null;
  const metadata = (entry: CatalogEntry) => (
    <span className="cr-picker-text">
      <span>{entry.title || t('pickerUntitled')}</span>
      <code className="cr-muted">{entry.id}</code>
      {entry.cwd && <span className="cr-muted">{entry.cwd}</span>}
    </span>
  );
  const candidateMessage: TextKey | null = candidates.count
    ? null
    : catalog.state === 'loading'
      ? 'pickerLoading'
      : catalog.state === 'unavailable'
        ? 'pickerUnavailable'
        : query.trim()
          ? 'pickerNoMatches'
          : corpus?.mode === 'off' || (corpus?.mode === 'selected' && !lines(corpus.text).length)
            ? 'pickerCorpusEmpty'
            : corpus?.mode === 'selected'
              ? 'pickerNoCorpusMatches'
              : 'pickerEmpty';
  return (
    <section
      className="cr-picker"
      aria-label={t(name === 'embedding' ? 'embeddingIds' : 'corpusIds')}
    >
      <Field id={`${id}-search`} label={t('pickerSearch')} description={t('pickerHelp')}>
        <Input
          id={`${id}-search`}
          type="search"
          value={query}
          disabled={disabled}
          aria-describedby={`${id}-search-help`}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setCandidatePage(0);
            setSelectedPage(0);
          }}
        />
      </Field>
      <h3>{t('pickerSelected', { count: selected.length })}</h3>
      {selections.count ? (
        <ul className="cr-picker-list" aria-label={t('pickerSelected', { count: selected.length })}>
          {selections.items.map((entry) => (
            <li key={entry.id} className="cr-picker-selected">
              <div className="cr-picker-text">
                {metadata(entry)}
                {entry.missing && <span className="cr-muted">{t('pickerMissing')}</span>}
                {!entry.allowed && <span className="cr-permission-note">{t('pickerOutside')}</span>}
              </div>
              <Button
                disabled={disabled}
                aria-label={t('pickerRemove', {
                  title: entry.title || t('pickerUntitled'),
                  id: entry.id,
                })}
                onClick={() => onToggle(entry.id, false)}
              >
                {t('remove')}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="cr-muted">{t(selected.length ? 'pickerNoMatches' : 'pickerSelectedEmpty')}</p>
      )}
      {pagination(selections, setSelectedPage)}
      <h3>{t('pickerCandidates')}</h3>
      {catalog.state === 'loading' || catalog.state === 'unavailable' ? (
        <p className="cr-muted" role="status">
          {t(catalog.state === 'loading' ? 'pickerLoading' : 'pickerUnavailable')}
        </p>
      ) : catalog.stale ? (
        <p className="cr-muted" role="status">
          {t('pickerStale')}
        </p>
      ) : catalog.refreshing ? (
        <p className="cr-muted" role="status">
          {t('pickerRefreshing')}
        </p>
      ) : null}
      {candidates.count ? (
        <ul className="cr-picker-list" aria-label={t('pickerCandidates')}>
          {candidates.items.map((entry) => (
            <li key={entry.id}>
              <Checkbox
                disabled={disabled}
                checked={selectedIds.has(entry.id)}
                onChange={(checked) => onToggle(entry.id, checked)}
                label={metadata(entry)}
              />
            </li>
          ))}
        </ul>
      ) : candidateMessage &&
        candidateMessage !== 'pickerLoading' &&
        candidateMessage !== 'pickerUnavailable' ? (
        <p className="cr-muted" role="status">
          {t(candidateMessage)}
        </p>
      ) : null}
      {pagination(candidates, setCandidatePage)}
      {candidates.hasMore && <p className="cr-muted">{t('pickerMore')}</p>}
    </section>
  );
}

function Editor({
  ctx,
  mirror,
  entryId,
  describe,
  catalog,
  t,
}: {
  ctx: ClientContext;
  mirror: DescribeMirror;
  entryId: string;
  describe: DescribeSnapshot;
  catalog: SessionCatalog;
  t: Translate;
}) {
  const form = React.useMemo(() => ctx.configForms.get(entryId), [ctx, entryId]);
  const snapshot = useSnapshot(form);
  const [state, setState] = React.useState<EditorState | null>(null);
  const mounted = React.useRef(false);
  const saving = React.useRef(false);
  const id = React.useId();
  const accepted = React.useMemo(() => configuration(snapshot.value), [snapshot.value]);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  React.useEffect(() => {
    if (snapshot.status !== 'ready' || snapshot.revision === undefined || !accepted) return;
    const revision = snapshot.revision;
    setState((previous) => {
      if (previous === null) return initial(accepted, revision);
      // Never replace a dirty or rejected draft during shared-mirror refresh.
      if (
        !dirty(previous) &&
        !previous.saving &&
        previous.result !== 'rejected' &&
        previous.revision !== revision
      )
        return initial(accepted, revision);
      return previous;
    });
  }, [accepted, snapshot.status, snapshot.revision]);
  if (!state)
    return (
      <div className="cr-empty">
        <Notice>
          {t(
            snapshot.status === 'unavailable'
              ? 'unavailable'
              : snapshot.status === 'ready' && !accepted
                ? 'wrongShape'
                : 'loading',
          )}
        </Notice>
        <Refresh mirror={mirror} t={t} />
      </div>
    );
  const checked = validate(state.draft);
  const permission = confirmations(state.base, checked.value);
  const changed = dirty(state);
  const stale = snapshot.revision !== undefined && snapshot.revision !== state.revision;
  const served = describe.view?.namespaces.some((entry) => entry.ns === entryId) ?? false;
  const ambiguous =
    (describe.view?.namespaces.filter((entry) => isRecallNamespace(entry.ns)).length ?? 0) > 1;
  const writable =
    served &&
    !ambiguous &&
    snapshot.status === 'ready' &&
    snapshot.writable &&
    describe.view?.writable === true &&
    accepted !== null;
  const locked = state.saving || !writable;
  const disabledSave =
    locked ||
    !changed ||
    checked.errors.length > 0 ||
    (permission.local && !state.localConfirmed) ||
    (permission.outbound && !state.outboundConfirmed);
  const change = (update: (draft: Draft) => Draft) => {
    setState((previous) =>
      previous && !previous.saving
        ? {
            ...previous,
            draft: update(previous.draft),
            localConfirmed: false,
            outboundConfirmed: false,
            result: null,
          }
        : previous,
    );
  };
  const save = async () => {
    if (disabledSave || saving.current) return;
    saving.current = true;
    setState((previous) => (previous ? { ...previous, saving: true, result: null } : previous));
    try {
      const ok = await form.mutate(operations(checked.value), state.revision);
      if (!mounted.current) return;
      if (!ok) {
        setState((previous) =>
          previous ? { ...previous, saving: false, result: 'rejected' } : previous,
        );
        return;
      }
      const current = form.getSnapshot();
      const value = current.status === 'ready' ? configuration(current.value) : null;
      if (value && current.revision !== undefined)
        setState({ ...initial(value, current.revision), result: 'saved' });
      else
        setState((previous) =>
          previous ? { ...previous, saving: false, result: 'rejected' } : previous,
        );
    } catch {
      if (mounted.current)
        setState((previous) =>
          previous ? { ...previous, saving: false, result: 'rejected' } : previous,
        );
    } finally {
      saving.current = false;
    }
  };
  const reset = (keepDraft: boolean) => {
    if (!accepted || snapshot.revision === undefined || snapshot.status !== 'ready' || state.saving)
      return;
    setState({
      ...initial(accepted, snapshot.revision),
      ...(keepDraft ? { draft: state.draft, result: 'rebased' as const } : {}),
    });
  };
  const field = (
    name: string,
    label: TextKey,
    help: TextKey,
    value: string,
    onChange: (value: string) => void,
    multiline = false,
    numeric?: { min: number; max: number },
  ) => (
    <Field id={`${id}-${name}`} label={t(label)} description={t(help)}>
      {multiline ? (
        <Textarea
          id={`${id}-${name}`}
          value={value}
          rows={4}
          disabled={locked}
          aria-describedby={`${id}-${name}-help`}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      ) : (
        <Input
          id={`${id}-${name}`}
          value={value}
          type={numeric ? 'number' : 'text'}
          {...(numeric
            ? { min: numeric.min, max: numeric.max, step: 'any', inputMode: 'decimal' as const }
            : {})}
          disabled={locked}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={`${id}-${name}-help`}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      )}
    </Field>
  );
  const scope = (name: 'corpus' | 'embedding') => {
    const value = state.draft[name];
    const embedding = name === 'embedding';
    return (
      <FieldSet
        className="cr-section--single"
        title={t(embedding ? 'embeddingLegend' : 'corpusLegend')}
        description={t(embedding ? 'embeddingHelp' : 'corpusHelp')}
      >
        <Field
          id={`${id}-${name}-mode`}
          label={t(embedding ? 'embeddingMode' : 'corpusMode')}
          description={t(embedding ? 'embeddingSubset' : 'pickerHelp')}
        >
          <ChoiceCards
            id={`${id}-${name}-mode`}
            value={value.mode}
            disabled={locked}
            onChange={(mode) => {
              if (mode !== 'off' && mode !== 'selected' && mode !== 'all') return;
              change((draft) => ({ ...draft, [name]: { ...draft[name], mode } }));
            }}
            options={[
              { value: 'off', label: t('off') },
              { value: 'selected', label: t('selected') },
              { value: 'all', label: t(embedding ? 'embeddingAll' : 'all') },
            ]}
          />
        </Field>
        {value.mode === 'selected' && (
          <SessionPicker
            name={name}
            value={value}
            {...(embedding ? { corpus: state.draft.corpus } : {})}
            catalog={catalog}
            disabled={locked}
            t={t}
            onToggle={(sessionId, selected) =>
              change((draft) => ({
                ...draft,
                [name]: toggleSelection(
                  draft[name],
                  sessionId,
                  selected,
                  pickerEntries(catalog.entries, embedding ? draft.corpus : undefined),
                ),
              }))
            }
          />
        )}
      </FieldSet>
    );
  };
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      aria-busy={state.saving}
    >
      <p className="cr-muted">
        {t('namespace')}: <code>{entryId}</code>
      </p>
      {accepted && <SavedSummary value={accepted} t={t} />}
      {(!served || snapshot.status === 'unavailable') && <Notice>{t('unavailable')}</Notice>}
      {snapshot.status === 'ready' && !accepted && <Notice kind="error">{t('wrongShape')}</Notice>}
      {ambiguous && <Notice kind="error">{t('ambiguous')}</Notice>}
      {served && (!snapshot.writable || describe.view?.writable !== true) && (
        <Notice>{t('readonly')}</Notice>
      )}
      {scope('corpus')}
      {scope('embedding')}
      <FieldSet title={t('syncLegend')}>
        <Toggle
          id={`${id}-auto-sync`}
          checked={state.draft.autoSync}
          onChange={(autoSync) => change((draft) => ({ ...draft, autoSync }))}
          disabled={locked}
          label={t('autoSync')}
          description={t('autoSyncHelp')}
        />
      </FieldSet>
      <Advanced title={t('advanced')}>
        <div className="cr-fields-grid">
          {field('node', 'nodePath', 'nodeHelp', state.draft.nodePath, (nodePath) =>
            change((draft) => ({ ...draft, nodePath })),
          )}
          {field('data', 'dataPath', 'dataHelp', state.draft.dataPath, (dataPath) =>
            change((draft) => ({ ...draft, dataPath })),
          )}
          {field('env', 'envFile', 'envHelp', state.draft.envFile, (envFile) =>
            change((draft) => ({ ...draft, envFile })),
          )}
          {field(
            'callers',
            'callerIds',
            'callerHelp',
            state.draft.callers,
            (callers) => change((draft) => ({ ...draft, callers })),
            true,
          )}
          {field(
            'minimum',
            'dominantMin',
            'minHelp',
            state.draft.dominantMin,
            (dominantMin) => change((draft) => ({ ...draft, dominantMin })),
            false,
            { min: 0, max: 1 },
          )}
          {field(
            'gap',
            'dominantGap',
            'gapHelp',
            state.draft.dominantGap,
            (dominantGap) => change((draft) => ({ ...draft, dominantGap })),
            false,
            { min: 0, max: 2 },
          )}
        </div>
      </Advanced>
      {checked.errors.length > 0 && (
        <Notice kind="error">
          <strong>{t('validationHeading')}</strong>
          <ul>
            {checked.errors.map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ul>
        </Notice>
      )}
      {changed && (permission.local || permission.outbound) && (
        <FieldSet title={t('confirmations')} className="cr-confirmations">
          {permission.local && (
            <Checkbox
              id={`${id}-confirm-local`}
              disabled={locked}
              checked={state.localConfirmed}
              onChange={(localConfirmed) =>
                setState((previous) => (previous ? { ...previous, localConfirmed } : previous))
              }
              label={t('localConfirm')}
            />
          )}
          {permission.outbound && (
            <div>
              <p className="cr-permission-note">{t('outboundWarning')}</p>
              <Checkbox
                id={`${id}-confirm-outbound`}
                disabled={locked}
                checked={state.outboundConfirmed}
                onChange={(outboundConfirmed) =>
                  setState((previous) => (previous ? { ...previous, outboundConfirmed } : previous))
                }
                label={t('outboundConfirm')}
              />
            </div>
          )}
        </FieldSet>
      )}
      <p className="cr-muted">{t('saveImpact')}</p>
      {stale && (
        <Notice kind="warning">
          <p>{t('stale')}</p>
          <p className="cr-muted">{t('rebaseHelp')}</p>
          <Button disabled={locked || !accepted} onClick={() => reset(true)}>
            {t('rebase')}
          </Button>
        </Notice>
      )}
      <footer className="cr-sticky-footer">
        <div className="cr-status">
          {state.result ? (
            <Notice
              kind={
                state.result === 'rejected'
                  ? 'error'
                  : state.result === 'saved'
                    ? 'success'
                    : 'info'
              }
            >
              {t(state.result)}
            </Notice>
          ) : (
            <p role="status" aria-live="polite" className="cr-muted">
              {t(changed ? 'dirty' : 'pristine')}
            </p>
          )}
        </div>
        <div className="cr-actions">
          <Button variant="primary" type="submit" disabled={disabledSave}>
            {t(state.saving ? 'saving' : 'save')}
          </Button>
          <Button
            disabled={
              state.saving ||
              !accepted ||
              snapshot.status !== 'ready' ||
              (!changed && !stale && !state.result)
            }
            onClick={() => reset(false)}
          >
            {t('discard')}
          </Button>
          <Refresh mirror={mirror} t={t} disabled={state.saving} />
        </div>
        <p className="cr-muted">{t('refreshNote')}</p>
      </footer>
    </form>
  );
}

function isRecallNamespace(ns: string) {
  return (
    ns === 'dsh-chat-recall' || ns === 'include:dsh-chat-recall' || ns.endsWith(':dsh-chat-recall')
  );
}

export function createSettingsPage(ctx: ClientContext): React.ComponentType<SettingsSectionProps> {
  const mirror = ctx.configForms.describe();
  return function SettingsPage({ useSessions }: SettingsSectionProps) {
    useSnapshot(ctx.locale);
    const t = ctx.locale.bind('chat-recall') as Translate;
    // The Slot owns this metadata subscription; titles never retain a Session.
    const catalog = useSessions(sessionCatalog, sameCatalog);
    const describe = useSnapshot(mirror);
    React.useEffect(() => {
      void mirror.ensure().catch(() => undefined);
    }, []);
    const entries = describe.view?.namespaces.filter((entry) => isRecallNamespace(entry.ns)) ?? [];
    return (
      <main className="dsh-chat-recall">
        <style>{css}</style>
        <header className="cr-header">
          <div>
            <h1>{t('title')}</h1>
            <p className="cr-muted">{t('introduction')}</p>
          </div>
        </header>
        {describe.error && <Notice kind="warning">{t('readFailed')}</Notice>}
        {entries.length === 1 ? (
          <Editor
            key={entries[0]!.ns}
            ctx={ctx}
            mirror={mirror}
            entryId={entries[0]!.ns}
            describe={describe}
            catalog={catalog}
            t={t}
          />
        ) : (
          <div className="cr-empty">
            <Notice kind={entries.length > 1 ? 'error' : 'info'}>
              {t(
                entries.length > 1
                  ? 'ambiguous'
                  : describe.status === 'ready'
                    ? 'unavailable'
                    : 'loading',
              )}
            </Notice>
            <Refresh mirror={mirror} t={t} />
          </div>
        )}
      </main>
    );
  };
}
