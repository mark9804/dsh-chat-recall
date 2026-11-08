export const en = {
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
  pickerCorpusEmpty: 'Choose a local corpus first to make conversations available for embedding.',
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
  emptySelected: 'A Selected scope needs at least one conversation. Choose Off for no permission.',
  invalidSubset:
    'Embedding permission must be within the local corpus. Turn embedding Off or update its selection.',
  invalidNode: 'Node executable must be “node” or an absolute path.',
  invalidData: 'The local index data directory must be an absolute path.',
  invalidEnv:
    'The environment-file value must be an absolute path, not credentials or file contents.',
  invalidMin: 'Minimum cosine similarity must be a finite number from 0 to 1.',
  invalidGap: 'Similarity gap must be a finite number from 0 to 2.',
};
export type TextKey = keyof typeof en;
export type Translate = (key: TextKey, parameters?: Record<string, string | number>) => string;
export const zh: Record<TextKey, string> = {
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
  dataHelp: '填写 Host 上的绝对路径；每个插件实例使用独立目录。更改此路径不会移动或删除旧索引。',
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
