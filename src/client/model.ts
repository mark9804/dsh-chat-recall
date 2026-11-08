import type { SessionListSnapshot, SettingsPathOp } from './contracts.js';
import type { TextKey } from './locale.js';

export type ScopeMode = 'off' | 'selected' | 'all';

export interface ScopeDraft {
  mode: ScopeMode;
  text: string;
}

export interface CatalogEntry {
  id: string;
  title: string;
  cwd: string;
}

export interface SessionCatalog {
  entries: readonly CatalogEntry[];
  state: 'loading' | 'unavailable' | 'ready';
  refreshing: boolean;
  stale: boolean;
}

export interface PickerSelection extends CatalogEntry {
  missing: boolean;
  allowed: boolean;
}

export interface PickerPage<T> {
  items: readonly T[];
  page: number;
  count: number;
  from: number;
  to: number;
  hasPrevious: boolean;
  hasMore: boolean;
}

export interface Configuration {
  nodePath: string;
  dataPath: string;
  envFile?: string;
  sessionIds: string[];
  embeddingSessionIds: string[];
  callerSessionIds: string[];
  autoSync: boolean;
  dominantMin: number;
  dominantGap: number;
}

export interface Draft {
  nodePath: string;
  dataPath: string;
  envFile: string;
  corpus: ScopeDraft;
  embedding: ScopeDraft;
  callers: string;
  autoSync: boolean;
  dominantMin: string;
  dominantGap: string;
}

export interface EditorState {
  base: Configuration;
  revision: number;
  draft: Draft;
  localConfirmed: boolean;
  outboundConfirmed: boolean;
  saving: boolean;
  result: 'saved' | 'rejected' | 'rebased' | null;
}

export interface Validation {
  value: Configuration;
  errors: TextKey[];
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
}

export function normalizeScope(ids: readonly string[]): string[] {
  const normalized = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  return normalized.includes('all') ? ['all'] : normalized;
}

export function configuration(value: unknown): Configuration | null {
  if (
    !record(value) ||
    typeof value.nodePath !== 'string' ||
    typeof value.dataPath !== 'string' ||
    (value.envFile !== undefined && typeof value.envFile !== 'string') ||
    !strings(value.sessionIds) ||
    !strings(value.embeddingSessionIds) ||
    !strings(value.callerSessionIds) ||
    typeof value.autoSync !== 'boolean' ||
    typeof value.dominantMin !== 'number' ||
    typeof value.dominantGap !== 'number'
  )
    return null;
  return {
    nodePath: value.nodePath,
    dataPath: value.dataPath,
    ...(value.envFile ? { envFile: value.envFile } : {}),
    sessionIds: normalizeScope(value.sessionIds),
    embeddingSessionIds: normalizeScope(value.embeddingSessionIds),
    callerSessionIds: [...new Set(value.callerSessionIds)],
    autoSync: value.autoSync,
    dominantMin: value.dominantMin,
    dominantGap: value.dominantGap,
  };
}

export function scopeDraft(ids: readonly string[]): ScopeDraft {
  return {
    mode: ids.includes('all') ? 'all' : ids.length ? 'selected' : 'off',
    text: ids.filter((id) => id !== 'all').join('\n'),
  };
}

export function draftOf(value: Configuration): Draft {
  return {
    nodePath: value.nodePath,
    dataPath: value.dataPath,
    envFile: value.envFile ?? '',
    corpus: scopeDraft(value.sessionIds),
    embedding: scopeDraft(value.embeddingSessionIds),
    callers: value.callerSessionIds.join('\n'),
    autoSync: value.autoSync,
    dominantMin: String(value.dominantMin),
    dominantGap: String(value.dominantGap),
  };
}

export function initial(value: Configuration, revision: number): EditorState {
  return {
    base: value,
    revision,
    draft: draftOf(value),
    localConfirmed: false,
    outboundConfirmed: false,
    saving: false,
    result: null,
  };
}

export function dirty(state: EditorState): boolean {
  return JSON.stringify(state.draft) !== JSON.stringify(draftOf(state.base));
}

export function lines(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

export function scopeIds(scope: ScopeDraft): string[] {
  return scope.mode === 'all' ? ['all'] : scope.mode === 'off' ? [] : lines(scope.text);
}

export function validIds(ids: readonly string[]): boolean {
  return ids.every((id) => id !== 'all' && !/[\s\u0000-\u001f\u007f]/.test(id));
}

/** Select only catalog metadata: never request Session bodies or content search. */
export function sessionCatalog(snapshot: SessionListSnapshot): SessionCatalog {
  const seen = new Set<string>();
  const entries: CatalogEntry[] = [];
  // Guard the integration boundary, not only an empty list: an unsupported
  // snapshot must leave configuration visible, never crash the whole Slot.
  if (
    !snapshot ||
    !Array.isArray(snapshot.ids) ||
    !snapshot.byId ||
    typeof snapshot.byId !== 'object' ||
    Array.isArray(snapshot.byId)
  )
    return { entries, state: 'unavailable', refreshing: false, stale: false };
  for (const id of snapshot.ids) {
    if (typeof id !== 'string' || !id || !validIds([id]) || seen.has(id)) continue;
    const item = Object.hasOwn(snapshot.byId, id) ? snapshot.byId[id] : undefined;
    if (!item || item.origin === 'subagent' || item.id !== id) continue;
    seen.add(id);
    entries.push({
      id,
      title:
        typeof item.title === 'string' && item.title.trim()
          ? item.title.trim()
          : typeof item.displayTitle === 'string'
            ? item.displayTitle.trim()
            : '',
      cwd: typeof item.cwd === 'string' ? item.cwd : '',
    });
  }
  // The public source exposes only arrival phase, not refresh/error status.
  return {
    entries,
    state: snapshot.phase === 'ready' ? 'ready' : 'loading',
    refreshing: false,
    stale: false,
  };
}

export function sameCatalog(a: SessionCatalog, b: SessionCatalog): boolean {
  return (
    a.state === b.state &&
    a.refreshing === b.refreshing &&
    a.stale === b.stale &&
    a.entries.length === b.entries.length &&
    a.entries.every((entry, index) => {
      const other = b.entries[index];
      return other?.id === entry.id && other.title === entry.title && other.cwd === entry.cwd;
    })
  );
}

export function pickerEntries(
  entries: readonly CatalogEntry[],
  corpus?: ScopeDraft,
): readonly CatalogEntry[] {
  if (!corpus || corpus.mode === 'all') return entries;
  if (corpus.mode === 'off') return [];
  const allowed = new Set(lines(corpus.text));
  return entries.filter((entry) => allowed.has(entry.id));
}

export function pickerSelections(
  scope: ScopeDraft,
  entries: readonly CatalogEntry[],
  corpus?: ScopeDraft,
): PickerSelection[] {
  if (scope.mode !== 'selected') return [];
  const metadata = new Map(entries.map((entry) => [entry.id, entry]));
  const allowed = corpus?.mode === 'selected' ? new Set(lines(corpus.text)) : null;
  return lines(scope.text).map((id) => ({
    ...(metadata.get(id) ?? { id, title: '', cwd: '' }),
    missing: !metadata.has(id),
    allowed: !corpus || corpus.mode === 'all' || (allowed?.has(id) ?? false),
  }));
}

export function searchEntries<T extends CatalogEntry>(
  entries: readonly T[],
  query: string,
): readonly T[] {
  const terms = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  if (!terms.length) return entries;
  return entries.filter((entry) => {
    const text = `${entry.title}\n${entry.id}\n${entry.cwd}`.toLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

/** Both candidate and selected lists use fixed-size pages, even for large corpora. */
export function pickerPage<T>(items: readonly T[], requestedPage: number): PickerPage<T> {
  const size = 50;
  const last = Math.max(0, Math.ceil(items.length / size) - 1);
  const page = Math.min(
    last,
    Math.max(0, Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 0),
  );
  const start = page * size;
  return {
    items: items.slice(start, start + size),
    page,
    count: items.length,
    from: items.length ? start + 1 : 0,
    to: Math.min(start + size, items.length),
    hasPrevious: page > 0,
    hasMore: page < last,
  };
}

export function toggleSelection(
  scope: ScopeDraft,
  id: string,
  checked: boolean,
  available: readonly CatalogEntry[],
): ScopeDraft {
  if (scope.mode !== 'selected') return scope;
  // Only visible, corpus-eligible metadata can add a grant; unavailable saved IDs can be removed.
  if (checked && (!id || !validIds([id]) || !available.some((entry) => entry.id === id)))
    return scope;
  const ids = lines(scope.text);
  if (checked === ids.includes(id)) return scope;
  return {
    ...scope,
    text: (checked ? [...ids, id] : ids.filter((item) => item !== id)).join('\n'),
  };
}

export function absolutePath(value: string): boolean {
  return (
    !/[\r\n\u0000]/.test(value) &&
    (value.startsWith('/') || /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value))
  );
}

export function subset(next: readonly string[], before: readonly string[]): boolean {
  return (
    !next.length ||
    before.includes('all') ||
    (!next.includes('all') && next.every((id) => before.includes(id)))
  );
}

export function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

export function validate(draft: Draft): Validation {
  const errors: TextKey[] = [];
  const sessionIds = scopeIds(draft.corpus);
  const embeddingSessionIds = scopeIds(draft.embedding);
  const callerSessionIds = lines(draft.callers);
  for (const scope of [draft.corpus, draft.embedding]) {
    if (scope.mode !== 'selected') continue;
    const ids = lines(scope.text);
    if (!ids.length) errors.push('emptySelected');
    if (!validIds(ids)) errors.push('invalidIds');
  }
  if (!validIds(callerSessionIds)) errors.push('invalidIds');
  if (
    embeddingSessionIds.length &&
    (!sessionIds.length ||
      (draft.embedding.mode !== 'all' && !subset(embeddingSessionIds, sessionIds)))
  )
    errors.push('invalidSubset');
  const nodePath = draft.nodePath.trim();
  const dataPath = draft.dataPath.trim();
  const envFile = draft.envFile.trim();
  if (nodePath !== 'node' && !absolutePath(nodePath)) errors.push('invalidNode');
  if (!absolutePath(dataPath)) errors.push('invalidData');
  if (envFile && !absolutePath(envFile)) errors.push('invalidEnv');
  const dominantMin = Number(draft.dominantMin);
  const dominantGap = Number(draft.dominantGap);
  if (
    !draft.dominantMin.trim() ||
    !Number.isFinite(dominantMin) ||
    dominantMin < 0 ||
    dominantMin > 1
  )
    errors.push('invalidMin');
  if (
    !draft.dominantGap.trim() ||
    !Number.isFinite(dominantGap) ||
    dominantGap < 0 ||
    dominantGap > 2
  )
    errors.push('invalidGap');
  return {
    errors: [...new Set(errors)],
    value: {
      nodePath,
      dataPath,
      ...(envFile ? { envFile } : {}),
      sessionIds,
      embeddingSessionIds,
      callerSessionIds,
      autoSync: draft.autoSync,
      dominantMin,
      dominantGap,
    },
  };
}

export function confirmations(
  base: Configuration,
  next: Configuration,
): {
  local: boolean;
  outbound: boolean;
} {
  return {
    local:
      !subset(next.sessionIds, base.sessionIds) ||
      (!base.autoSync && next.autoSync && next.sessionIds.length > 0),
    // Conservative: any changed non-empty grant/corpus/destination asks again.
    outbound:
      next.embeddingSessionIds.length > 0 &&
      (!sameSet(next.embeddingSessionIds, base.embeddingSessionIds) ||
        !sameSet(next.sessionIds, base.sessionIds) ||
        next.envFile !== base.envFile),
  };
}

export function operations(value: Configuration): SettingsPathOp[] {
  const fields = [
    'nodePath',
    'dataPath',
    'sessionIds',
    'embeddingSessionIds',
    'callerSessionIds',
    'autoSync',
    'dominantMin',
    'dominantGap',
  ] as const;
  return [
    ...fields.map((field): SettingsPathOp => ({ op: 'set', path: [field], value: value[field] })),
    value.envFile
      ? { op: 'set', path: ['envFile'], value: value.envFile }
      : { op: 'unset', path: ['envFile'] },
  ];
}
