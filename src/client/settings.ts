import type {
  ClientContext,
  ConfigForm,
  DescribeSnapshot,
  Observable,
  ReactNode,
  SessionListSnapshot,
  SettingsPathOp,
  SettingsSectionProps,
} from './contracts.js';

/** The only emitted browser entry. All runtime code stays inside this loader factory. */
window.__ModuleLoader__.load({
  id: 'dsh-chat-recall',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const en = {
      title: 'Chat recall',
      introduction:
        'Choose which conversations may be indexed locally and, separately, which may be sent to an embedding provider. Nothing is indexed or sent by opening this page.',
      loading: 'Loading the shared settings configuration…',
      unavailable:
        'Chat recall configuration is not currently served by the Host. Enable the Host plugin and its editable configuration, then refresh. This page will also update when it becomes available.',
      ambiguous:
        'More than one Chat recall configuration is available. This page cannot safely choose an instance; no configuration will be changed.',
      wrongShape:
        'The Host configuration is not compatible with this editor. No values will be written. Update the plugin and refresh.',
      readFailed:
        'The shared settings could not be refreshed. Any displayed values may be stale; your draft is preserved.',
      readonly:
        'The Host exposes this configuration as read-only. You can review it, but cannot save changes.',
      refresh: 'Refresh configuration',
      refreshing: 'Refreshing…',
      refreshNote:
        'Refresh only reloads the shared configuration. It does not index conversations or send text.',
      namespace: 'Configuration entry',
      summary: 'Saved configuration',
      summaryNote:
        'Configuration only—not live index progress. Use chat_recall_status to inspect coverage, sync failures and embedding progress.',
      localScope: 'Local corpus',
      embeddingScope: 'Embedding permission',
      syncSummary: 'Automatic local indexing',
      on: 'Enabled',
      off: 'Off',
      selectedSummary: '{count} selected conversations',
      allSummary: 'All main conversations, including archived conversations and user forks',
      embeddingAllSummary: 'All conversations within the configured local corpus',
      corpusLegend: '1. Local indexing scope',
      corpusHelp:
        'Local indexing stores derived conversation text in the data directory. Off authorizes no conversations; it does not delete previously derived index files.',
      corpusMode: 'Conversations allowed for local indexing',
      selected: 'Selected conversations',
      all: 'All conversations',
      corpusIds: 'Choose local corpus conversations',
      pickerHelp:
        'Search titles, IDs or working directories from the DSH conversation catalog. Only metadata is read—no messages are opened or searched. Checking a conversation changes only this draft; new catalog entries are never selected automatically.',
      pickerSearch: 'Search conversations',
      pickerSelected: 'Selected conversations ({count})',
      pickerSelectedEmpty: 'No conversations selected. Choose at least one, or choose Off.',
      pickerCandidates: 'Available conversations',
      pickerUntitled: 'Untitled conversation',
      pickerMissing: 'Not in the current catalog; saved ID retained',
      pickerOutside: 'Outside the current local corpus; remove this selection or update the corpus',
      pickerRemove: 'Remove {title} ({id})',
      remove: 'Remove',
      pickerLoading: 'Loading conversation metadata…',
      pickerRefreshing: 'Refreshing conversation metadata; displayed entries may be stale.',
      pickerUnavailable:
        'The conversation catalog is unavailable. Existing selections are preserved and can still be removed. Reconnect DSH to load the catalog.',
      pickerStale:
        'The conversation catalog could not be refreshed. Displayed metadata may be stale; existing selections are preserved.',
      pickerEmpty: 'No conversations are available in the current catalog.',
      pickerNoMatches: 'No conversations match this title, ID or working directory.',
      pickerCorpusEmpty:
        'Choose a local corpus first to make conversations available for embedding.',
      pickerNoCorpusMatches:
        'No catalog entries belong to the selected local corpus. Saved selections remain listed above.',
      pickerPage: 'Showing {from}–{to} of {count}',
      pickerPrevious: 'Previous 50',
      pickerNext: 'Next 50',
      pickerMore: 'More results are available. Use the next page or narrow your search.',
      embeddingLegend: '2. Outbound embedding permission',
      embeddingHelp:
        'Independent of local indexing. Semantic search and explicit embedding tools may send allowed conversation text and search queries to the configured embedding provider. This page never starts embedding or semantic search.',
      embeddingMode: 'Conversations allowed for outbound embedding',
      embeddingAll: 'All within the local corpus',
      embeddingIds: 'Choose conversations allowed for embedding',
      embeddingSubset:
        'Selected embedding IDs must also belong to the local corpus. “All within the local corpus” includes future additions to that corpus. With local indexing Off, embedding must also be Off.',
      syncLegend: '3. Local synchronization',
      autoSync: 'Automatically index the allowed local corpus',
      autoSyncHelp:
        'Enabling this starts local backfill and committed-message indexing after Save. It does not automatically create embeddings. Off stops background syncing; explicit local indexing tools remain available for the allowed corpus.',
      advanced: 'Advanced configuration',
      nodePath: 'Independent Node executable',
      nodeHelp:
        'Use an absolute Node.js executable path, or “node” to resolve through the Host PATH. Requires Node.js 22.6 or later with native-module support.',
      dataPath: 'Local index data directory',
      dataHelp:
        'Absolute path on the Host. Use a separate directory for each plugin instance. Changing this path does not move or delete the old index.',
      envFile: 'Embedding environment-file path (optional)',
      envHelp:
        'Absolute path on the Host, read only by the worker. Enter a path, never API keys or file contents. Credentials are not loaded into this browser. Blank removes the user override and restores any inherited path.',
      callerIds: 'Caller conversation allowlist (optional)',
      callerHelp:
        'One exact caller conversation ID per line. Empty allows tool access from this profile; a non-empty list restricts callers. This does not expand the corpus or embedding permission. There is no “all” sentinel here.',
      dominantMin: 'Minimum top cosine similarity',
      minHelp: '0–1. Heuristic for single-candidate presentation, not a confidence score.',
      dominantGap: 'Minimum top-two similarity gap',
      gapHelp: '0–2. Required difference between the two highest cosine similarities.',
      confirmations: 'Review permissions before saving',
      localConfirm:
        'I authorize this local indexing scope and understand that automatic indexing, if enabled, starts after saving.',
      outboundConfirm:
        'I authorize sending allowed conversation text and semantic queries to the configured embedding provider when semantic search or explicit embedding tools run.',
      outboundWarning:
        'Outbound permission is separate from local storage. Review the provider and its data policy before granting access. The confirmation is required again when a non-empty embedding permission, corpus, or environment-file path changes.',
      saveImpact:
        'Saving applies every field atomically. Accepted changes restart the recall worker and invalidate existing search/read cursors. No save occurs until you press Save.',
      save: 'Save configuration',
      saving: 'Saving…',
      discard: 'Discard draft and use latest configuration',
      dirty: 'Unsaved changes',
      pristine: 'No unsaved changes',
      saved:
        'Configuration saved. The Host applies the new configuration; worker status is not reported here.',
      rejected:
        'Save was rejected or could not be confirmed. The configuration may have changed elsewhere, be read-only, or fail Host validation. Your draft is preserved. Refresh before reviewing and trying again.',
      stale:
        'The saved configuration changed while you were editing. Your draft and original revision are preserved; saving cannot silently overwrite the newer revision.',
      rebase: 'Review my draft against the latest revision',
      rebaseHelp:
        'This keeps every draft field and adopts the latest revision. Saving afterwards overwrites those fields with your draft; review all fields and permissions first. Discard instead to use the latest values.',
      rebased:
        'Your draft is now based on the latest revision. Review every field and confirm any permissions again before saving.',
      validationHeading: 'Fix these fields before saving:',
      invalidIds:
        'Conversation IDs must be one per line, with no embedded whitespace or control characters. Choose All in the selector rather than typing “all”.',
      emptySelected:
        'A Selected scope needs at least one conversation. Choose Off for no permission.',
      invalidSubset:
        'Embedding permission must be within the local corpus. Turn embedding Off or update its selection.',
      invalidNode: 'Node executable must be “node” or an absolute path.',
      invalidData: 'The local index data directory must be an absolute path.',
      invalidEnv:
        'The environment-file value must be an absolute path, not credentials or file contents.',
      invalidMin: 'Minimum cosine similarity must be a finite number from 0 to 1.',
      invalidGap: 'Similarity gap must be a finite number from 0 to 2.',
    };
    type TextKey = keyof typeof en;
    const zh: Record<TextKey, string> = {
      title: '对话回溯',
      introduction:
        '分别选择允许建立本地索引的会话，以及允许向嵌入服务发送文本的会话。仅打开此页面不会索引或外发任何内容。',
      loading: '正在加载共享配置…',
      unavailable:
        'Host 当前未提供聊天检索配置。请启用 Host 插件及其可编辑配置后刷新；配置上线后此页面也会自动更新。',
      ambiguous: '发现多个聊天检索配置实例，此页面无法安全选择。不会修改任何配置。',
      wrongShape: 'Host 配置与此编辑器不兼容，不会写入任何值。请更新插件后刷新。',
      readFailed: '共享配置刷新失败。当前显示的值可能已过期；你的草稿已保留。',
      readonly: 'Host 将此配置设为只读。可以查看，但无法保存更改。',
      refresh: '刷新配置',
      refreshing: '正在刷新…',
      refreshNote: '刷新只重新读取共享配置，不会索引会话或发送文本。',
      namespace: '配置实例',
      summary: '已保存的配置',
      summaryNote:
        '这里只展示配置，不代表实时索引进度。实际覆盖、同步失败和向量进度请通过 chat_recall_status 查看。',
      localScope: '本地语料范围',
      embeddingScope: '嵌入外发权限',
      syncSummary: '自动本地索引',
      on: '开启',
      off: '关闭',
      selectedSummary: '已选 {count} 个会话',
      allSummary: '全部主会话，包括归档会话和用户分支',
      embeddingAllSummary: '本地语料范围内的全部会话',
      corpusLegend: '1. 本地索引范围',
      corpusHelp:
        '本地索引在数据目录保存派生的会话文本。关闭表示不授权任何会话；不会删除已经生成的索引文件。',
      corpusMode: '允许建立本地索引的会话',
      selected: '指定会话',
      all: '全部会话',
      corpusIds: '选择本地语料会话',
      pickerHelp:
        '按标题、ID 或工作目录搜索 DSH 会话目录。只读取元数据，不打开或搜索消息内容。勾选只修改当前草稿；目录中新增的会话不会自动选中。',
      pickerSearch: '搜索会话',
      pickerSelected: '已选会话（{count}）',
      pickerSelectedEmpty: '尚未选择会话。请至少选择一个，或切换为关闭。',
      pickerCandidates: '可选会话',
      pickerUntitled: '未命名会话',
      pickerMissing: '当前目录中不可用；保留已保存的 ID',
      pickerOutside: '不在当前本地语料范围内；请移除此项或修改语料范围',
      pickerRemove: '移除 {title}（{id}）',
      remove: '移除',
      pickerLoading: '正在加载会话元数据…',
      pickerRefreshing: '正在刷新会话元数据；当前显示的条目可能已过期。',
      pickerUnavailable: '会话目录暂不可用。已有选择已保留，仍可移除；重新连接 DSH 后可加载目录。',
      pickerStale: '会话目录刷新失败。当前元数据可能已过期，已有选择已保留。',
      pickerEmpty: '当前目录中没有可选会话。',
      pickerNoMatches: '没有标题、ID 或工作目录匹配的会话。',
      pickerCorpusEmpty: '请先选择本地语料，才能选择允许嵌入的会话。',
      pickerNoCorpusMatches: '当前会话目录中没有属于指定本地语料的条目。已有选择仍保留在上方。',
      pickerPage: '显示第 {from}–{to} 项，共 {count} 项',
      pickerPrevious: '前 50 项',
      pickerNext: '后 50 项',
      pickerMore: '还有更多结果，可翻页或缩小搜索范围。',
      embeddingLegend: '2. 嵌入外发权限',
      embeddingHelp:
        '与本地索引独立。语义搜索和显式嵌入工具可能将已授权会话文本及搜索查询发送到所配置的嵌入服务。此页面不会启动嵌入或语义搜索。',
      embeddingMode: '允许向嵌入服务外发的会话',
      embeddingAll: '本地语料范围内的全部会话',
      embeddingIds: '选择允许嵌入的会话',
      embeddingSubset:
        '指定的嵌入会话必须属于本地语料范围。“范围内全部”也包含以后加入语料的会话。本地索引范围关闭时，嵌入权限也必须关闭。',
      syncLegend: '3. 本地同步',
      autoSync: '自动索引已授权的本地语料',
      autoSyncHelp:
        '开启并保存后，将开始本地历史回填和已提交消息的增量索引；不会自动生成嵌入。关闭会停止后台同步，但已授权语料仍可由显式工具建立本地索引。',
      advanced: '高级配置',
      nodePath: '独立 Node 可执行文件',
      nodeHelp:
        '填写 Node.js 可执行文件的绝对路径，或填写“node”通过 Host 的 PATH 查找。需要支持原生模块的 Node.js 22.6 或更高版本。',
      dataPath: '本地索引数据目录',
      dataHelp:
        '填写 Host 上的绝对路径；每个插件实例使用独立目录。更改此路径不会移动或删除旧索引。',
      envFile: '嵌入环境文件路径（可选）',
      envHelp:
        '填写 Host 上的绝对路径，仅由工作进程读取。只能填写路径，不能填写 API 密钥或文件内容；浏览器不会读取凭证。留空将移除用户覆盖值，恢复可能存在的继承路径。',
      callerIds: '调用方会话白名单（可选）',
      callerHelp:
        '每行填写一个准确的调用方会话 ID。留空允许当前配置档的会话使用工具；非空时限制调用方。此设置不会扩大语料或嵌入权限，这里不支持“all”保留字。',
      dominantMin: '最高余弦相似度下限',
      minHelp: '范围 0–1。用于单候选展示的启发式规则，不是置信度分数。',
      dominantGap: '前两名相似度差距下限',
      gapHelp: '范围 0–2。最高和第二高余弦相似度之间要求的差值。',
      confirmations: '保存前确认权限',
      localConfirm: '我授权以上本地索引范围，并理解开启自动索引后会在保存时开始索引。',
      outboundConfirm:
        '我授权在运行语义搜索或显式嵌入工具时，将允许的会话文本与语义查询发送到所配置的嵌入服务。',
      outboundWarning:
        '外发权限与本地存储独立。授权前请确认服务商及其数据政策。非空嵌入权限、语料范围或环境文件路径改变时，需要重新确认。',
      saveImpact:
        '保存会一次性提交所有字段。接受配置后将重启检索工作进程，使已有搜索／读取游标失效。点击保存之前不会写入配置。',
      save: '保存配置',
      saving: '正在保存…',
      discard: '放弃草稿并使用最新配置',
      dirty: '有未保存的更改',
      pristine: '没有未保存的更改',
      saved: '配置已保存，Host 将应用新配置；此页面不报告工作进程状态。',
      rejected:
        '保存被拒绝或无法确认。配置可能已被其他页面修改、处于只读状态，或未通过 Host 校验。草稿已保留，请先刷新，再检查并重试。',
      stale: '编辑期间已保存的配置发生了变化。草稿和原始版本已保留；保存不会静默覆盖较新的版本。',
      rebase: '基于最新版本重新检查我的草稿',
      rebaseHelp:
        '此操作保留所有草稿字段，并采用最新版本号。之后保存会用草稿覆盖这些字段，请检查全部字段和权限；若要使用最新配置，请选择放弃草稿。',
      rebased: '草稿已采用最新版本号。保存前请检查所有字段，并重新确认相关权限。',
      validationHeading: '保存前请修正以下字段：',
      invalidIds:
        '会话 ID 必须每行一个，不得含内部空白或控制字符。请通过选择器选择全部，不要填写“all”。',
      emptySelected: '指定会话模式至少需要选择一个会话。不授权任何会话请选关闭。',
      invalidSubset: '嵌入权限必须处于本地语料范围内。请关闭嵌入或修改会话选择。',
      invalidNode: 'Node 可执行文件必须是“node”或绝对路径。',
      invalidData: '本地索引数据目录必须是绝对路径。',
      invalidEnv: '环境文件必须是绝对路径，不能填写凭证或文件内容。',
      invalidMin: '余弦相似度下限必须是 0 到 1 之间的有限数值。',
      invalidGap: '相似度差距必须是 0 到 2 之间的有限数值。',
    };

    type ScopeMode = 'off' | 'selected' | 'all';
    interface ScopeDraft {
      mode: ScopeMode;
      text: string;
    }
    interface CatalogEntry {
      id: string;
      title: string;
      cwd: string;
    }
    interface SessionCatalog {
      entries: readonly CatalogEntry[];
      state: 'loading' | 'unavailable' | 'ready';
      refreshing: boolean;
      stale: boolean;
    }
    interface PickerSelection extends CatalogEntry {
      missing: boolean;
      allowed: boolean;
    }
    interface PickerPage<T> {
      items: readonly T[];
      page: number;
      count: number;
      from: number;
      to: number;
      hasPrevious: boolean;
      hasMore: boolean;
    }
    interface Configuration {
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
    interface Draft {
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
    interface EditorState {
      base: Configuration;
      revision: number;
      draft: Draft;
      localConfirmed: boolean;
      outboundConfirmed: boolean;
      saving: boolean;
      result: 'saved' | 'rejected' | 'rebased' | null;
    }
    interface ChangeEvent {
      currentTarget: { value: string; checked: boolean };
    }
    interface SubmitEvent {
      preventDefault(): void;
    }
    interface Validation {
      value: Configuration;
      errors: TextKey[];
    }

    function record(value: unknown): value is Record<string, unknown> {
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    }
    function strings(value: unknown): value is string[] {
      return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
    }
    function normalizeScope(ids: readonly string[]): string[] {
      const normalized = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
      return normalized.includes('all') ? ['all'] : normalized;
    }
    function configuration(value: unknown): Configuration | null {
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
    function scopeDraft(ids: readonly string[]): ScopeDraft {
      return {
        mode: ids.includes('all') ? 'all' : ids.length ? 'selected' : 'off',
        text: ids.filter((id) => id !== 'all').join('\n'),
      };
    }
    function draftOf(value: Configuration): Draft {
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
    function initial(value: Configuration, revision: number): EditorState {
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
    function dirty(state: EditorState): boolean {
      return JSON.stringify(state.draft) !== JSON.stringify(draftOf(state.base));
    }
    function lines(text: string): string[] {
      return [
        ...new Set(
          text
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean),
        ),
      ];
    }
    function scopeIds(scope: ScopeDraft): string[] {
      return scope.mode === 'all' ? ['all'] : scope.mode === 'off' ? [] : lines(scope.text);
    }
    function validIds(ids: readonly string[]): boolean {
      return ids.every((id) => id !== 'all' && !/[\s\u0000-\u001f\u007f]/.test(id));
    }
    /** Select only catalog metadata: never request Session bodies or content search. */
    function sessionCatalog(snapshot: SessionListSnapshot): SessionCatalog {
      const seen = new Set<string>();
      const entries: CatalogEntry[] = [];
      for (const item of snapshot.items) {
        if (
          item.origin === 'subagent' ||
          !item.sessionId ||
          !validIds([item.sessionId]) ||
          seen.has(item.sessionId)
        )
          continue;
        seen.add(item.sessionId);
        entries.push({
          id: item.sessionId,
          title: item.title?.trim() ?? '',
          cwd: item.cwd ?? '',
        });
      }
      const failed = snapshot.state === 'error' || snapshot.error != null;
      return {
        entries,
        state:
          failed && !entries.length
            ? 'unavailable'
            : snapshot.phase === 'ready'
              ? 'ready'
              : failed
                ? 'unavailable'
                : 'loading',
        refreshing: snapshot.phase === 'ready' && snapshot.state === 'loading',
        stale: failed,
      };
    }
    function sameCatalog(a: SessionCatalog, b: SessionCatalog): boolean {
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
    function pickerEntries(
      entries: readonly CatalogEntry[],
      corpus?: ScopeDraft,
    ): readonly CatalogEntry[] {
      if (!corpus || corpus.mode === 'all') return entries;
      if (corpus.mode === 'off') return [];
      const allowed = new Set(lines(corpus.text));
      return entries.filter((entry) => allowed.has(entry.id));
    }
    function pickerSelections(
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
    function searchEntries<T extends CatalogEntry>(
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
    function pickerPage<T>(items: readonly T[], requestedPage: number): PickerPage<T> {
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
    function toggleSelection(
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
    function absolutePath(value: string): boolean {
      return (
        !/[\r\n\u0000]/.test(value) &&
        (value.startsWith('/') || /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value))
      );
    }
    function subset(next: readonly string[], before: readonly string[]): boolean {
      return (
        !next.length ||
        before.includes('all') ||
        (!next.includes('all') && next.every((id) => before.includes(id)))
      );
    }
    function sameSet(a: readonly string[], b: readonly string[]): boolean {
      return a.length === b.length && a.every((id) => b.includes(id));
    }
    function validate(draft: Draft): Validation {
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
    function confirmations(
      base: Configuration,
      next: Configuration,
    ): { local: boolean; outbound: boolean } {
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
    function operations(value: Configuration): SettingsPathOp[] {
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
        ...fields.map(
          (field): SettingsPathOp => ({ op: 'set', path: [field], value: value[field] }),
        ),
        value.envFile
          ? { op: 'set', path: ['envFile'], value: value.envFile }
          : { op: 'unset', path: ['envFile'] },
      ];
    }
    function useSnapshot<T>(source: Observable<T>): T {
      const callbacks = React.useMemo(
        () => ({
          subscribe: (listener: () => void) => source.subscribe(listener),
          read: () => source.getSnapshot(),
        }),
        [source],
      );
      return React.useSyncExternalStore(callbacks.subscribe, callbacks.read);
    }

    const styles = `
.dsh-chat-recall{max-width:760px;min-width:0;margin:0 auto;padding:16px;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:1.6;overflow-wrap:anywhere}
.dsh-chat-recall *{box-sizing:border-box}
.dsh-chat-recall h2{font-size:20px;font-weight:600;margin:0 0 8px}
.dsh-chat-recall h3{font-size:15px;font-weight:600;margin:0 0 8px}
.dsh-chat-recall p{margin:8px 0}
.dsh-chat-recall .cr-muted{color:var(--dsw-alias-label-secondary);font-size:13px}
.dsh-chat-recall fieldset,.dsh-chat-recall .cr-summary{min-width:0;margin:20px 0;padding:16px;border:.5px solid var(--dsw-alias-border-l2);border-radius:12px}
.dsh-chat-recall legend{padding:0 6px;font-weight:600}
.dsh-chat-recall .cr-field{display:flex;flex-direction:column;gap:6px;margin:14px 0}
.dsh-chat-recall label{font-weight:500}
.dsh-chat-recall input:not([type=checkbox]),.dsh-chat-recall textarea,.dsh-chat-recall select{width:100%;min-width:0;max-width:100%;padding:8px 10px;font:inherit;line-height:1.5;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:8px}
.dsh-chat-recall textarea{resize:vertical;min-height:100px}
.dsh-chat-recall .cr-checkbox{display:flex;align-items:flex-start;gap:10px;margin:12px 0;font-weight:400;cursor:pointer}
.dsh-chat-recall input[type=checkbox]{flex:none;width:16px;height:16px;margin:4px 0;accent-color:var(--dsw-alias-brand-primary)}
.dsh-chat-recall button{padding:8px 12px;min-height:36px;font:inherit;line-height:1.4;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;cursor:pointer}
.dsh-chat-recall button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.dsh-chat-recall button.cr-primary{font-weight:600;border-color:var(--dsw-alias-brand-primary)}
.dsh-chat-recall :disabled{opacity:.55;cursor:not-allowed}
.dsh-chat-recall :is(input,textarea,select,button,summary):focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}
.dsh-chat-recall .cr-actions{display:flex;flex-wrap:wrap;gap:10px;margin:16px 0}
.dsh-chat-recall .cr-notice{padding:12px 14px;margin:12px 0;border-inline-start:3px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1);border-radius:6px}
.dsh-chat-recall .cr-notice ul{margin:6px 0;padding-inline-start:22px}
.dsh-chat-recall dl{display:grid;grid-template-columns:minmax(100px,1fr) minmax(0,2fr);gap:8px 16px;margin:0}
.dsh-chat-recall dt{color:var(--dsw-alias-label-secondary)}
.dsh-chat-recall dd{margin:0}
.dsh-chat-recall details{margin:20px 0;padding:14px 0;border-top:.5px solid var(--dsw-alias-border-l2);border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dsh-chat-recall summary{cursor:pointer;font-weight:600}
.dsh-chat-recall .cr-picker{min-width:0;margin:14px 0}
.dsh-chat-recall .cr-picker-list{list-style:none;margin:8px 0;padding:0;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;max-height:360px;overflow:auto}
.dsh-chat-recall .cr-picker-list li+li{border-top:.5px solid var(--dsw-alias-border-l2)}
.dsh-chat-recall .cr-picker-list .cr-checkbox{margin:0;padding:10px 12px}
.dsh-chat-recall .cr-picker-text{display:flex;flex:1;min-width:0;flex-direction:column;gap:2px}
.dsh-chat-recall .cr-picker-text code{font-size:12px}
.dsh-chat-recall .cr-picker-selected{display:flex;align-items:flex-start;gap:10px;padding:10px 12px}
.dsh-chat-recall .cr-picker-selected button{flex:none}
.dsh-chat-recall .cr-picker-pagination{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:8px 0}
.dsh-chat-recall .cr-picker-pagination span{flex:1;min-width:140px}
@media(max-width:480px){.dsh-chat-recall{padding:12px}.dsh-chat-recall fieldset,.dsh-chat-recall .cr-summary{padding:12px}.dsh-chat-recall dl{grid-template-columns:1fr;gap:4px}.dsh-chat-recall dd{margin-bottom:8px}.dsh-chat-recall .cr-actions button{width:100%}}
`;

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx: ClientContext) {
        ctx.effect(
          () => ctx.locale.register('chat-recall', { en, zh }),
          'chat-recall: dictionaries',
        );
        const translate = ctx.locale.bind('chat-recall');
        const t = (key: TextKey, parameters?: Record<string, string | number>): string =>
          translate(key, parameters);
        const mirror = ctx.configForms.describe();

        function Refresh({ disabled = false }: { disabled?: boolean }): ReactNode {
          const [loading, setLoading] = React.useState(false);
          const mounted = React.useRef(false);
          React.useEffect(() => {
            mounted.current = true;
            return () => {
              mounted.current = false;
            };
          }, []);
          const refresh = async (): Promise<void> => {
            if (loading) return;
            setLoading(true);
            try {
              await mirror.load();
            } finally {
              if (mounted.current) setLoading(false);
            }
          };
          return h(
            'button',
            {
              type: 'button',
              disabled: disabled || loading,
              onClick: () => {
                void refresh().catch(() => undefined);
              },
            },
            t(loading ? 'refreshing' : 'refresh'),
          );
        }
        function savedSummary(value: Configuration): ReactNode {
          const scopeText = (ids: string[], embedding: boolean): string =>
            ids.includes('all')
              ? t(embedding ? 'embeddingAllSummary' : 'allSummary')
              : ids.length
                ? t('selectedSummary', { count: ids.length })
                : t('off');
          return h(
            'section',
            { className: 'cr-summary', 'aria-label': t('summary') },
            h('h3', null, t('summary')),
            h(
              'dl',
              null,
              h('dt', null, t('localScope')),
              h('dd', null, scopeText(value.sessionIds, false)),
              h('dt', null, t('embeddingScope')),
              h('dd', null, scopeText(value.embeddingSessionIds, true)),
              h('dt', null, t('syncSummary')),
              h('dd', null, t(value.autoSync ? 'on' : 'off')),
            ),
            h('p', { className: 'cr-muted' }, t('summaryNote')),
          );
        }

        function SessionPicker({
          name,
          value,
          corpus,
          catalog,
          disabled,
          onToggle,
        }: {
          name: 'corpus' | 'embedding';
          value: ScopeDraft;
          corpus?: ScopeDraft;
          catalog: SessionCatalog;
          disabled: boolean;
          onToggle: (id: string, checked: boolean) => void;
        }): ReactNode {
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
          const selectedMatches = React.useMemo(
            () => searchEntries(selected, query),
            [selected, query],
          );
          const candidates = pickerPage(matches, candidatePage);
          const selections = pickerPage(selectedMatches, selectedPage);
          const pagination = (
            page: PickerPage<unknown>,
            setPage: (page: number) => void,
          ): ReactNode =>
            page.count
              ? h(
                  'div',
                  { className: 'cr-picker-pagination' },
                  h(
                    'span',
                    { className: 'cr-muted' },
                    t('pickerPage', {
                      from: page.from,
                      to: page.to,
                      count: page.count,
                    }),
                  ),
                  page.count > 50
                    ? [
                        h(
                          'button',
                          {
                            key: 'previous',
                            type: 'button',
                            disabled: disabled || !page.hasPrevious,
                            onClick: () => setPage(page.page - 1),
                          },
                          t('pickerPrevious'),
                        ),
                        h(
                          'button',
                          {
                            key: 'next',
                            type: 'button',
                            disabled: disabled || !page.hasMore,
                            onClick: () => setPage(page.page + 1),
                          },
                          t('pickerNext'),
                        ),
                      ]
                    : null,
                )
              : null;
          const metadata = (entry: CatalogEntry): ReactNode =>
            h(
              'span',
              { className: 'cr-picker-text' },
              h('span', null, entry.title || t('pickerUntitled')),
              h('code', { className: 'cr-muted' }, entry.id),
              entry.cwd ? h('span', { className: 'cr-muted' }, entry.cwd) : null,
            );
          const candidateMessage: TextKey | null = candidates.count
            ? null
            : catalog.state === 'loading'
              ? 'pickerLoading'
              : catalog.state === 'unavailable'
                ? 'pickerUnavailable'
                : corpus?.mode === 'off' ||
                    (corpus?.mode === 'selected' && !lines(corpus.text).length)
                  ? 'pickerCorpusEmpty'
                  : query.trim()
                    ? 'pickerNoMatches'
                    : corpus?.mode === 'selected'
                      ? 'pickerNoCorpusMatches'
                      : 'pickerEmpty';
          return h(
            'div',
            {
              className: 'cr-picker',
              role: 'group',
              'aria-label': t(name === 'embedding' ? 'embeddingIds' : 'corpusIds'),
            },
            h(
              'div',
              { className: 'cr-field' },
              h('label', { htmlFor: `${id}-search` }, t('pickerSearch')),
              h('input', {
                id: `${id}-search`,
                type: 'search',
                value: query,
                disabled,
                autoComplete: 'off',
                spellCheck: false,
                'aria-describedby': `${id}-help`,
                onChange: (event: ChangeEvent) => {
                  setQuery(event.currentTarget.value);
                  setCandidatePage(0);
                  setSelectedPage(0);
                },
              }),
              h('span', { id: `${id}-help`, className: 'cr-muted' }, t('pickerHelp')),
            ),
            h('h3', null, t('pickerSelected', { count: selected.length })),
            selections.count
              ? h(
                  'ul',
                  {
                    className: 'cr-picker-list',
                    'aria-label': t('pickerSelected', { count: selected.length }),
                  },
                  ...selections.items.map((entry) =>
                    h(
                      'li',
                      { key: entry.id, className: 'cr-picker-selected' },
                      h(
                        'span',
                        { className: 'cr-picker-text' },
                        metadata(entry),
                        entry.missing
                          ? h('span', { className: 'cr-muted' }, t('pickerMissing'))
                          : null,
                        !entry.allowed
                          ? h('span', { className: 'cr-muted' }, t('pickerOutside'))
                          : null,
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          disabled,
                          'aria-label': t('pickerRemove', {
                            title: entry.title || t('pickerUntitled'),
                            id: entry.id,
                          }),
                          onClick: () => onToggle(entry.id, false),
                        },
                        t('remove'),
                      ),
                    ),
                  ),
                )
              : h(
                  'p',
                  { className: 'cr-muted' },
                  t(selected.length ? 'pickerNoMatches' : 'pickerSelectedEmpty'),
                ),
            pagination(selections, setSelectedPage),
            h('h3', null, t('pickerCandidates')),
            catalog.state === 'loading' || catalog.state === 'unavailable'
              ? h(
                  'p',
                  { className: 'cr-muted', role: 'status' },
                  t(catalog.state === 'loading' ? 'pickerLoading' : 'pickerUnavailable'),
                )
              : catalog.stale
                ? h('p', { className: 'cr-muted', role: 'status' }, t('pickerStale'))
                : catalog.refreshing
                  ? h('p', { className: 'cr-muted', role: 'status' }, t('pickerRefreshing'))
                  : null,
            candidates.count
              ? h(
                  'ul',
                  { className: 'cr-picker-list', 'aria-label': t('pickerCandidates') },
                  ...candidates.items.map((entry) =>
                    h(
                      'li',
                      { key: entry.id },
                      h(
                        'label',
                        { className: 'cr-checkbox' },
                        h('input', {
                          type: 'checkbox',
                          disabled,
                          checked: selectedIds.has(entry.id),
                          onChange: (event: ChangeEvent) =>
                            onToggle(entry.id, event.currentTarget.checked),
                        }),
                        metadata(entry),
                      ),
                    ),
                  ),
                )
              : candidateMessage &&
                  candidateMessage !== 'pickerLoading' &&
                  candidateMessage !== 'pickerUnavailable'
                ? h('p', { className: 'cr-muted', role: 'status' }, t(candidateMessage))
                : null,
            pagination(candidates, setCandidatePage),
            candidates.hasMore ? h('p', { className: 'cr-muted' }, t('pickerMore')) : null,
          );
        }

        function Editor({
          entryId,
          describe,
          catalog,
        }: {
          entryId: string;
          describe: DescribeSnapshot;
          catalog: SessionCatalog;
        }): ReactNode {
          useSnapshot(ctx.locale);
          const form: ConfigForm = React.useMemo(() => ctx.configForms.get(entryId), [entryId]);
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
            return h(
              'div',
              null,
              h(
                'p',
                { role: 'status' },
                t(
                  snapshot.status === 'unavailable'
                    ? 'unavailable'
                    : snapshot.status === 'ready' && !accepted
                      ? 'wrongShape'
                      : 'loading',
                ),
              ),
              h(Refresh, {}),
            );
          const checked = validate(state.draft);
          const permission = confirmations(state.base, checked.value);
          const changed = dirty(state);
          const stale = snapshot.revision !== undefined && snapshot.revision !== state.revision;
          const served = describe.view?.namespaces.some((entry) => entry.ns === entryId) ?? false;
          const ambiguous =
            (describe.view?.namespaces.filter(
              (entry) =>
                entry.ns === 'dsh-chat-recall' ||
                entry.ns === 'include:dsh-chat-recall' ||
                entry.ns.endsWith(':dsh-chat-recall'),
            ).length ?? 0) > 1;
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
          const change = (update: (draft: Draft) => Draft): void => {
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
          const save = async (): Promise<void> => {
            if (disabledSave || saving.current) return;
            saving.current = true;
            setState((previous) =>
              previous ? { ...previous, saving: true, result: null } : previous,
            );
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
          const reset = (keepDraft: boolean): void => {
            if (
              !accepted ||
              snapshot.revision === undefined ||
              snapshot.status !== 'ready' ||
              state.saving
            )
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
          ): ReactNode =>
            h(
              'div',
              { className: 'cr-field' },
              h('label', { htmlFor: `${id}-${name}` }, t(label)),
              h(multiline ? 'textarea' : 'input', {
                id: `${id}-${name}`,
                value,
                disabled: locked,
                'aria-describedby': `${id}-${name}-help`,
                ...(multiline
                  ? { rows: 4 }
                  : {
                      type: numeric ? 'number' : 'text',
                      ...(numeric
                        ? { min: numeric.min, max: numeric.max, step: 'any', inputMode: 'decimal' }
                        : {}),
                    }),
                autoComplete: 'off',
                spellCheck: false,
                onChange: (event: ChangeEvent) => onChange(event.currentTarget.value),
              }),
              h('span', { id: `${id}-${name}-help`, className: 'cr-muted' }, t(help)),
            );
          const scope = (name: 'corpus' | 'embedding'): ReactNode => {
            const value = state.draft[name];
            const embedding = name === 'embedding';
            return h(
              'fieldset',
              { disabled: locked },
              h('legend', null, t(embedding ? 'embeddingLegend' : 'corpusLegend')),
              h(
                'p',
                { className: 'cr-muted', id: `${id}-${name}-help` },
                t(embedding ? 'embeddingHelp' : 'corpusHelp'),
              ),
              h(
                'div',
                { className: 'cr-field' },
                h(
                  'label',
                  { htmlFor: `${id}-${name}-mode` },
                  t(embedding ? 'embeddingMode' : 'corpusMode'),
                ),
                h(
                  'select',
                  {
                    id: `${id}-${name}-mode`,
                    value: value.mode,
                    'aria-describedby': `${id}-${name}-help`,
                    onChange: (event: ChangeEvent) => {
                      const mode = event.currentTarget.value;
                      if (mode !== 'off' && mode !== 'selected' && mode !== 'all') return;
                      change((draft) => ({ ...draft, [name]: { ...draft[name], mode } }));
                    },
                  },
                  h('option', { value: 'off' }, t('off')),
                  h('option', { value: 'selected' }, t('selected')),
                  h('option', { value: 'all' }, t(embedding ? 'embeddingAll' : 'all')),
                ),
              ),
              value.mode === 'selected'
                ? h(SessionPicker, {
                    name,
                    value,
                    ...(embedding ? { corpus: state.draft.corpus } : {}),
                    catalog,
                    disabled: locked,
                    onToggle: (sessionId: string, selected: boolean) =>
                      change((draft) => ({
                        ...draft,
                        [name]: toggleSelection(
                          draft[name],
                          sessionId,
                          selected,
                          pickerEntries(catalog.entries, embedding ? draft.corpus : undefined),
                        ),
                      })),
                  })
                : null,
              embedding ? h('p', { className: 'cr-muted' }, t('embeddingSubset')) : null,
            );
          };
          const checkbox = (
            name: string,
            key: TextKey,
            checkedValue: boolean,
            onChange: (checked: boolean) => void,
          ): ReactNode =>
            h(
              'label',
              { className: 'cr-checkbox', htmlFor: `${id}-${name}` },
              h('input', {
                id: `${id}-${name}`,
                type: 'checkbox',
                checked: checkedValue,
                disabled: locked,
                onChange: (event: ChangeEvent) => onChange(event.currentTarget.checked),
              }),
              h('span', null, t(key)),
            );
          return h(
            'form',
            {
              onSubmit: (event: SubmitEvent) => {
                event.preventDefault();
                void save();
              },
              'aria-busy': state.saving,
            },
            h('p', { className: 'cr-muted' }, t('namespace'), ': ', h('code', null, entryId)),
            accepted ? savedSummary(accepted) : null,
            !served || snapshot.status === 'unavailable'
              ? h('p', { className: 'cr-notice', role: 'status' }, t('unavailable'))
              : null,
            snapshot.status === 'ready' && !accepted
              ? h('p', { className: 'cr-notice', role: 'alert' }, t('wrongShape'))
              : null,
            ambiguous ? h('p', { className: 'cr-notice', role: 'alert' }, t('ambiguous')) : null,
            served && (!snapshot.writable || describe.view?.writable !== true)
              ? h('p', { className: 'cr-notice', role: 'status' }, t('readonly'))
              : null,
            scope('corpus'),
            scope('embedding'),
            h(
              'fieldset',
              { disabled: locked },
              h('legend', null, t('syncLegend')),
              checkbox('auto-sync', 'autoSync', state.draft.autoSync, (autoSync) =>
                change((draft) => ({ ...draft, autoSync })),
              ),
              h('p', { className: 'cr-muted' }, t('autoSyncHelp')),
            ),
            h(
              'details',
              null,
              h('summary', null, t('advanced')),
              field('node', 'nodePath', 'nodeHelp', state.draft.nodePath, (nodePath) =>
                change((draft) => ({ ...draft, nodePath })),
              ),
              field('data', 'dataPath', 'dataHelp', state.draft.dataPath, (dataPath) =>
                change((draft) => ({ ...draft, dataPath })),
              ),
              field('env', 'envFile', 'envHelp', state.draft.envFile, (envFile) =>
                change((draft) => ({ ...draft, envFile })),
              ),
              field(
                'callers',
                'callerIds',
                'callerHelp',
                state.draft.callers,
                (callers) => change((draft) => ({ ...draft, callers })),
                true,
              ),
              field(
                'minimum',
                'dominantMin',
                'minHelp',
                state.draft.dominantMin,
                (dominantMin) => change((draft) => ({ ...draft, dominantMin })),
                false,
                { min: 0, max: 1 },
              ),
              field(
                'gap',
                'dominantGap',
                'gapHelp',
                state.draft.dominantGap,
                (dominantGap) => change((draft) => ({ ...draft, dominantGap })),
                false,
                { min: 0, max: 2 },
              ),
            ),
            checked.errors.length
              ? h(
                  'div',
                  { className: 'cr-notice', role: 'alert' },
                  h('strong', null, t('validationHeading')),
                  h('ul', null, ...checked.errors.map((key) => h('li', { key }, t(key)))),
                )
              : null,
            changed && (permission.local || permission.outbound)
              ? h(
                  'fieldset',
                  { disabled: locked },
                  h('legend', null, t('confirmations')),
                  permission.local
                    ? checkbox(
                        'confirm-local',
                        'localConfirm',
                        state.localConfirmed,
                        (localConfirmed) =>
                          setState((previous) =>
                            previous ? { ...previous, localConfirmed } : previous,
                          ),
                      )
                    : null,
                  permission.outbound
                    ? h(
                        'div',
                        null,
                        h('p', { className: 'cr-muted' }, t('outboundWarning')),
                        checkbox(
                          'confirm-outbound',
                          'outboundConfirm',
                          state.outboundConfirmed,
                          (outboundConfirmed) =>
                            setState((previous) =>
                              previous ? { ...previous, outboundConfirmed } : previous,
                            ),
                        ),
                      )
                    : null,
                )
              : null,
            h('p', { className: 'cr-muted' }, t('saveImpact')),
            stale
              ? h(
                  'div',
                  { className: 'cr-notice', role: 'status' },
                  h('p', null, t('stale')),
                  h('p', { className: 'cr-muted' }, t('rebaseHelp')),
                  h(
                    'button',
                    { type: 'button', disabled: locked || !accepted, onClick: () => reset(true) },
                    t('rebase'),
                  ),
                )
              : null,
            h(
              'div',
              { role: 'status', 'aria-live': 'polite', 'aria-atomic': true },
              state.result
                ? h('p', { className: 'cr-notice' }, t(state.result))
                : h('p', { className: 'cr-muted' }, t(changed ? 'dirty' : 'pristine')),
            ),
            h(
              'div',
              { className: 'cr-actions' },
              h(
                'button',
                { className: 'cr-primary', type: 'submit', disabled: disabledSave },
                t(state.saving ? 'saving' : 'save'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  disabled:
                    state.saving ||
                    !accepted ||
                    snapshot.status !== 'ready' ||
                    (!changed && !stale && !state.result),
                  onClick: () => reset(false),
                },
                t('discard'),
              ),
              h(Refresh, { disabled: state.saving }),
            ),
            h('p', { className: 'cr-muted' }, t('refreshNote')),
          );
        }

        function SettingsPage({ useSessions }: SettingsSectionProps): ReactNode {
          useSnapshot(ctx.locale);
          // The Slot owns this metadata subscription; selecting titles never retains a Session.
          const catalog = useSessions(sessionCatalog, sameCatalog);
          const describe = useSnapshot(mirror);
          const [entryId, setEntryId] = React.useState<string | null>(null);
          const namespaces =
            describe.view?.namespaces.filter(
              (entry) =>
                entry.ns === 'dsh-chat-recall' ||
                entry.ns === 'include:dsh-chat-recall' ||
                entry.ns.endsWith(':dsh-chat-recall'),
            ) ?? [];
          const availableId = namespaces.length === 1 ? namespaces[0]?.ns : undefined;
          React.useEffect(() => {
            void mirror.ensure().catch(() => undefined);
          }, []);
          React.useEffect(() => {
            if (entryId === null && availableId) setEntryId(availableId);
          }, [entryId, availableId]);
          return h(
            'section',
            { className: 'dsh-chat-recall', 'aria-label': t('title') },
            h('style', null, styles),
            h('h2', null, t('title')),
            h('p', { className: 'cr-muted' }, t('introduction')),
            describe.error
              ? h('p', { className: 'cr-notice', role: 'alert' }, t('readFailed'))
              : null,
            entryId !== null
              ? h(Editor, { entryId, describe, catalog })
              : h(
                  'div',
                  null,
                  h(
                    'p',
                    { role: 'status' },
                    t(
                      namespaces.length > 1
                        ? 'ambiguous'
                        : !describe.view && !describe.error
                          ? 'loading'
                          : 'unavailable',
                    ),
                  ),
                  h(Refresh, {}),
                  h('p', { className: 'cr-muted' }, t('refreshNote')),
                ),
          );
        }
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
      },
    };
  },
});
