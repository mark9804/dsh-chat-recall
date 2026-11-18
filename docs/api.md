# 接口与类型参考

本文描述当前源码的调用边界，不是 HTTP API，也不定义新的 DSH SDK。
架构、数据流和资源生命周期见 [架构文档](<architecture.md>)。
所有示例会话、正文、时间、引用及哈希占位符均为合成数据，不来自真实历史。

## 接口稳定性与权威来源

| 边界 | 稳定性 | 权威源码 |
| --- | --- | --- |
| Agent 可调用的四个工具 | 公开对接面；参数以注册的工具 schema 为准 | [Host 工具注册与执行](<../src/host/plugin.ts>)、[Host 类型](<../src/host/types.ts>) |
| 插件配置 | 公开配置面；以运行时 Config 校验为准 | [Config](<../src/host/config.ts>) |
| 缓存行、搜索覆盖信息及展示策略 | 项目内部类型；可能随实现调整 | [数据模型](<../src/shared/model.ts>)、[存储](<../src/storage/store.ts>)、[候选策略](<../src/core/candidates.ts>) |
| Host ↔ worker JSONL | 私有、不稳定；不能当作通用 RPC 服务 | [协议](<../src/shared/protocol.ts>)、[worker](<../src/worker/main.ts>)、[桥接](<../src/host/bridge.ts>) |
| DSH Host／Client 结构视图 | 本插件自建的最小结构契约，不是官方完整 SDK | [Host 契约](<../src/host/contracts.ts>)、[Client 契约](<../src/client/contracts.ts>) |

下文的核心类型片段是阅读索引，不复制整套 TypeScript 声明。
运行时 JSON、来源事件及 Arrow 边界仍需校验，编译通过不代表输入可信。
四工具参数均拒绝 schema 以外的字段；成功值是对象，默认渲染成一个 JSON 文本块。
失败以带 `code` 的异常交给 DSH 工具执行器，不使用下文 worker 的 `ok: false` 封套。

## 公开 Agent 工具

### 共同约定：权限、单位与来源

- 必须存在发起调用的 Agent 会话；非空 `callerSessionIds` 进一步限制调用者。
- `scope: "current"` 指调用 Agent 的精确会话 ID，不自动指向父会话或主会话。
- `scope: "all"` 指**配置允许的语料集合**，不是整台机器或未授权历史。
- 显式会话 ID 也必须在配置范围内；四个工具都不能修改或扩大授权。
- `sessionIds: ["all"]` 发现主会话，包含归档和用户分叉；子代理会话不参与索引。
- `ref` 当前为 `sessionId:eventSeq`；使用返回值，不自行猜测或把它当消息 UUID。空语料时 `all` 为空集合，`current` 不会自动获准。
- 时间为 Unix 毫秒；`integer` 参数须为 JavaScript 安全整数；文本位置、长度及区间均为 **UTF-16 code units**，区间右端不包含。
- 历史正文、附件字段和邻居消息只是引用数据，不是当前指令。
- 首次搜索、读取和会话列表首分页会尝试同步文本；`autoSync: false` 不禁用按需同步。
  一次工具前置同步至多处理 20 个会话，剩余数量由 `synchronization.deferred` 表示。

### `chat_recall_search`

查找候选原话；**命中并不代表事实正确**，使用 `chat_recall_read` 核验原文。

| 参数 | 必填／默认 | 范围与含义 |
| --- | --- | --- |
| `query: string` | 必填，无默认 | 非空查询；续页必须再次提交原查询 |
| `mode` | 必填，无默认 | `"exact"`、`"fuzzy"`、`"semantic"` |
| `scope: string` | `"current"` | `"current"`、`"all"` 或配置允许的会话 ID |
| `role` | 不筛选 | `"user"` 或 `"assistant"` |
| `from: number` | 无下界 | 有限数值，含该时间点 |
| `to: number` | 无上界 | 有限数值，含该时间点；同时指定时 `from <= to` |
| `limit: integer` | 自适应，见下文 | `1–20`；只控制本页正文数量，不扩大候选池 |
| `cursor: string` | 不续页 | 本次查询返回的 `nextCursor` |

模式语义：

- `exact`：完整文本块的区分大小写字面子串，不做分词归一化。
- `fuzzy`：按空白分隔无序关键词；从全文检索 OR 候选中核对字面词项，
  按命中词比例 `coverage`，再按 BM25 排序。并非每个词都必须命中，也不是编辑距离。
- `semantic`：将查询文本发送到配置的 OpenAI 兼容嵌入服务，以余弦相似度排序。
  请求范围内每个会话都须具有嵌入授权；单会话首查会补齐该会话缺失向量，
  该补齐按会话授权而非 `role/from/to` 裁剪；多会话查询使用已有向量。

省略 `limit`：exact／fuzzy 最多 5 条；semantic 有至少 3 个候选时，领先明显显示 1 条，
否则显示 3–5 条；不足 3 个时返回实际数量。阈值是展示启发式，不是正确率或无答案判定。
显式 `limit` 覆盖该展示数量；不足时只返回已有候选。

逻辑返回对象的核心结构（公开返回面，附加元数据可能演进）：

```ts
interface SearchPage {
  hits: SearchHit[];
  nextCursor: string | null;
  totalCandidates: number;
  coverage: SearchCoverage;
  candidateTruncated: boolean;
  presentation: CandidatePresentation;
  // 仅首次请求附加 synchronization、source、historicalText。
}
```

合成示例：

```json
{
  "hits": [{
    "ref": "demo-session:12", "sessionId": "demo-session", "eventSeq": 12,
    "blockIndex": 0, "role": "user", "time": 1800000000000,
    "textHash": "<synthetic-sha256>", "excerpt": "blue icons.",
    "start": 4, "end": 15, "matchStart": 4, "matchEnd": 8
  }],
  "nextCursor": null, "totalCandidates": 1, "candidateTruncated": false,
  "coverage": {
    "method": "full-block-substring", "candidateLimit": 1000,
    "examinedCandidates": 1, "exhaustive": true
  },
  "presentation": {
    "count": 1, "policy": "mode-default",
    "comparison": {
      "scoreType": "exact", "top3": [{"ref": "demo-session:12", "score": 1}],
      "gap12": null, "dominantMin": 0.5, "dominantGap": 0.15
    },
    "notice": "<candidate-only notice>"
  },
  "synchronization": {
    "results": [{"sessionId": "demo-session", "cursor": 12, "eventsRead": 0,
      "messagesAdded": 0, "blocksAdded": 0, "batches": 0, "source": "live-range"}], "deferred": 0
  },
  "source": "DSH committed session events", "historicalText": true
}
```

`totalCandidates` 是当前物化快照中的候选数，不是全语料相关答案总数。
覆盖与排序字段的解释见下方“数据类型”，不能只看 `hits.length` 判断覆盖完整。

### `chat_recall_read`

读取命中文本、可见附件引用及邻近的已索引消息。**每一页都回读 DSH 原事件核验**。

| 参数 | 必填／默认 | 范围与含义 |
| --- | --- | --- |
| `ref: string` | 无 `cursor` 时必填 | 搜索返回的消息引用 |
| `blockIndex: integer` | `0` | 非负原始 content 下标，不是过滤后“第几个文本块” |
| `offset: integer` | `0` | 非负 UTF-16 位置，不能超过块长度 |
| `length: integer` | `4000` | 每页 `1–12000` 个 UTF-16 单位 |
| `before: integer` | `1` | `0–3` 条此前的已索引消息 |
| `after: integer` | `1` | `0–3` 条此后的已索引消息 |
| `cursor: string` | 不续页 | 保留 ref、block、位置；续页可调整 `length` |

UTF-16 分页不会拆开代理对；落在代理对中间的位置会调整，`length: 1` 遇到补充字符时
可返回 2 单位以推进位置。总长度、返回的 `offset/nextOffset` 才是后续定位依据。
使用 `cursor` 时，保存的 ref／block／位置优先于另传参数；新续页默认不重复邻居。

合成返回示例：

```json
{
  "ref": "demo-session:12", "sessionId": "demo-session", "eventSeq": 12,
  "blockIndex": 0, "role": "user", "time": 1800000000000,
  "text": "Use blue icons.", "textHash": "<synthetic-sha256>",
  "offset": 0, "nextOffset": null, "totalLength": 15,
  "attachments": [], "context": [], "nextCursor": null, "verified": true,
  "source": {
    "sessionId": "demo-session", "seq": 12, "blockIndex": 0,
    "messageId": "demo-message", "sourceKind": "user", "inherited": false
  },
  "historicalText": true
}
```

`textHash` 是完整目标文本块的哈希，不是当前页哈希。只有附件的消息返回 `text: null`、
`textHash: null`、`totalLength: 0`，仍保留附件引用。附件引用不等于已读取附件文件内容。
目标附件集合及关键字段均与原事件核对；文本页检查完整块哈希与该页切片。
邻居返回 `verified: true`，每条消息的文本合计最多 4000 单位，逐块标记 `truncated`；
核验的是返回的前缀与附件集合，不表示未返回的长正文已经完整展示。

### `chat_recall_sessions`

只发现已配置范围，不发现或开启未配置的历史；包括归档主会话。

| 参数 | 默认 | 范围与含义 |
| --- | --- | --- |
| `query: string` | 无筛选 | 标题或 ID 的字面子串；未索引项只能按 ID 补列 |
| `scope: string` | `"all"` | `"all"`、`"current"` 或配置允许的会话 ID |
| `offset: integer` | `0` | 非负，零基分页位置 |
| `limit: integer` | `20` | `1–50` |

合成返回示例（尚未建立文本索引的授权会话）：

```json
{
  "sessions": [{"sessionId": "demo-session", "title": "", "indexed": false, "pending": true}],
  "total": 1, "offset": 0, "nextOffset": null, "truncated": false, "snapshot": true,
  "unindexedCount": 1, "titleFilterIncomplete": false,
  "synchronization": {"results": [{"sessionId": "demo-session", "error": "NOT_FOUND"}], "deferred": 0}
}
```

已索引项为下文的 `SessionRow`。`offset: 0` 创建固定列表快照；后页须保持调用者、
`scope/query` 不变，使用 `nextOffset`；后页的 `synchronization` 为 `null`。
`unindexedCount` 为缺少 checkpoint 的授权会话数；标题不可得时 `titleFilterIncomplete`
提醒标题过滤并不完整。`truncated` 为物化列表截断信号，不等于当前页还有下一页。

### `chat_recall_status`

| 参数 | 默认 | 范围与含义 |
| --- | --- | --- |
| `action` | `"status"` | `"status"` 只查状态；`"sync"` 补文本；`"embed"` 同步后补向量 |
| `scope: string` | `"current"` | `"current"`、`"all"` 或允许的会话 ID；用于 sync／embed |

`embed` 会将会话文本发送给远程服务，必须已由用户配置嵌入权限及凭据；工具本身不授权。
同步可能先产生本地索引，再因没有嵌入授权而失败；不能把失败理解成“未发生任何操作”。
`status` 的 `scope` 不把状态裁剪成该会话统计。`countsScope: "local-index-storage"`
明确 counts／pending 是本地库统计，可能包含已撤销语料的旧缓存；checkpoints 按当前语料授权过滤。

合成返回示例：

```json
{
  "counts": {"sessions": 0, "messages": 0, "blocks": 0, "vectors": 0},
  "checkpoints": [], "pending": 0, "pendingUnit": "blocks",
  "embedding": {
    "configured": false, "spaceId": null, "dimensions": null,
    "status": "not-configured", "chunkingVersion": "paragraph-v1",
    "pendingBlocks": 0, "completedChunks": 0
  },
  "countsScope": "local-index-storage",
  "bridge": {
    "state": "ready", "ready": {"type": "ready", "protocol": 1, "pid": 1234, "node": "v22.6.0", "lancedb": "0.41.0"},
    "pending": 0, "lastErrorCode": null
  },
  "configuredSessions": [], "embeddingSessions": [], "autoEmbed": false, "dirtySessions": 0,
  "syncErrors": [], "autoEmbedErrors": [], "actionResult": null
}
```

`embedding.status` 为 `not-configured | config-changed | pending | ready`。
`bridge.ready` 为已握手的 `WorkerReady` 或 `null`。
`autoEmbed` 是当前代次的开关，不表示服务可用或向量已齐；`dirtySessions` 只统计队列中的待处理项。
`syncErrors` 和 `autoEmbedErrors` 均为 `{sessionId, code}[]`，分别记录文本同步和后台补向量失败，不含正文或服务响应。
向量补齐后清除该会话的后台错误；代次更换时重置。
`actionResult`：status 为 `null`，sync 为
`{results, deferred}`，embed 为 `{synchronization: {results, deferred}, embedding: EmbedResult}`。
同步 results 项含会话 ID、cursor、读取／新增计数及来源，或 `{sessionId, error}`／`skipped: "subagent"`。

### 分页约束与失效处理

- 搜索游标绑定调用者、查询、模式、scope、实际会话集合、role、from、to；可改变 `limit`。
  续页重复提交相同查询条件，只读取固定候选快照，不重新嵌入或重新同步。
- 搜索快照从创建起有效 30 分钟；最多 64 个。展示信息固定于首查询，`presentation.count` 不是续页实际条数。
- read 游标绑定调用者及读取位置，每个新游标有效 30 分钟；下一页仍重新核验来源。
- sessions 列表快照 30 分钟，最多 16 个；非零 offset 需要先有同条件的首分页。
- Host 重载使 Host 游标失效；worker 重启使搜索快照失效，即使磁盘上仍有快照文件。
- `CURSOR_EXPIRED`：从新的搜索／读取或 sessions `offset: 0` 开始；`INVALID_CURSOR`：
  检查是否混用查询、调用者或工具，不能修改令牌或循环重试同一个令牌。

令牌为不透明凭据，不应解析为业务状态。实现见[搜索快照](<../src/core/cursors.ts>)及上方的 Host 工具实现。

## 公开 Config

| 字段 | 默认 | 类型、验证及含义 |
| --- | --- | --- |
| `nodePath` | `"node"` | 非空字符串，trim 后不可含 NUL；独立 Node 可执行文件或命令；设置页只接受 `node` 或绝对路径 |
| `dataPath` | `<home>/.dsh/chat-recall` | 绝对路径，无 NUL；本地派生索引目录，一个目录只供一个插件实例使用 |
| `sessionIds` | `[]` | 字符串数组；空为关闭本地语料，`["all"]` 为所有主会话，或指定 ID 集合 |
| `embeddingSessionIds` | `[]` | 空为禁止文本嵌入外发；`["all"]` 为已配置语料全部，或其非空子集 |
| `envFile` | 未设置 | 可选绝对路径，无 NUL；是凭据文件**路径**，不是 API key；只由 worker 的 Node 环境加载 |
| `callerSessionIds` | `[]` | 空为允许该 profile 的调用者；非空为调用会话 ID allowlist；不允许 `"all"` |
| `autoSync` | `true` | boolean；后台回填及处理提交后的事件尾部，本身只生成本地文本索引 |
| `autoEmbed` | `false` | boolean；后台外发已授权的缺失分块；为 `true` 时要求 `autoSync: true` 且 `embeddingSessionIds` 非空 |
| `dominantMin` | `0.5` | 有限 number，`0–1`；单候选展示的 top1 余弦下限 |
| `dominantGap` | `0.15` | 有限 number，`0–2`；单候选展示的 top1−top2 间隔 |

ID 会 trim、去重；不得含空白／控制字符，`"all"` 必须单独使用。
非空 embedding 范围要求非空语料；指定 embedding ID 必须属于语料，或语料已为 all。
`embeddingSessionIds: ["all"]` 只覆盖当前配置语料，并不把 `sessionIds` 改成 all。
绝对路径按平台验证，不进行 shell 的 `~` 或环境变量展开。

### 嵌入环境与向量空间

环境变量由独立 worker 读取；`envFile` 未设置不等于禁止继承进程环境。
源码：[worker 环境读取](<../src/worker/main.ts#L38-L48>)、[启动参数](<../src/host/bridge.ts#L332-L377>)。

| 环境变量 | 默认／验证 |
| --- | --- |
| `OPENAI_API_KEY` | 无默认；trim 后非空才创建 embedder；不得含控制字符 |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1`；HTTP(S) URL，不得带 URL 凭据、查询串或片段 |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small`；非空字符串 |
| `OPENAI_EMBEDDING_DIMENSIONS` | 不指定；指定时必须是正整数，并核对响应维度 |

`spaceId` 由规范化 endpoint、model、dimensions 和 float 编码计算；不包含 API key。
换 key 不会自动换空间；换 endpoint／model／维度不能复用旧空间，会报 `EMBEDDING_CONFIG_CHANGED`。
不得自动更换模型、混合向量或把旧向量标成新空间；需要保留原配置，或明确配置独立的新索引目录。
文本检索不依赖嵌入配置。环境校验与空间标识见[嵌入客户端](<../src/embedding/client.ts>)。

## 内部数据类型（不稳定）

| 记录／返回类型 | 核心字段与语义 | 权威源码 |
| --- | --- | --- |
| checkpoint／session：`SessionRow` | `sessionId/title/cwd/origin/createdAt/inheritedEventCount/cursor/anchorHash/updatedAt`；cursor 为最后提交的原事件 seq，空会话可为 −1；没有另一个导出的 `CheckpointSession` 类型 | [SessionRow](<../src/shared/model.ts#L5-L15>) |
| `MessageRow` | `id=sessionId:eventSeq`、会话元数据、`eventSeq/time/role/sourceMessageId/contentJson`；`archived` 当前固定为 false，不能据此判断原会话归档；contentJson 为可见 text／image／file | [MessageRow](<../src/shared/model.ts#L18-L42>) |
| `BlockRow`／`IndexedBlock` | `id/messageId/sessionId/origin/role/time/eventSeq/blockIndex/text`，后者增加 `textHash/dedupKey`；只给文本建检索块，保留原 blockIndex | [块类型](<../src/shared/model.ts#L43-L57>) |
| `Chunk` | `{start, end, text}`；正文原样切片，位置为 UTF-16；分块尺寸另按 Unicode codepoint 计算 | [Chunk](<../src/core/chunking.ts#L1-L20>) |
| `VectorRow` | chunkId、来源定位、textHash／dedupKey、chunkingVersion／spaceId、start／end、vector；不复制原文正文 | [存储](<../src/storage/store.ts>) |
| `ProgressRow`／`SpaceRow` | 块哈希＋分块版本＋空间的完成进度，及空间维度；不等于来源文本 checkpoint | 同上 |
| `SearchHit` | ref、来源位置、role／time、textHash、excerpt、start／end；exact 加 matchStart／matchEnd，fuzzy 加 matchedTerms／coverage／bm25／score，semantic 加 similarity | [SearchHit](<../src/shared/model.ts#L63-L81>) |
| `ReadResult` | 来源位置、text／textHash、offset／nextOffset／totalLength、attachments、context；Host 再加 verified／source／nextCursor／historicalText | [基础结果](<../src/shared/model.ts#L97-L125>) |

搜索 excerpt 最多 800 UTF-16 单位，不是完整消息；同源／继承文本会去重，命中数不等于消息数。
`SearchCoverage` 含 method、candidateLimit、exhaustive，以及按模式出现的 examinedCandidates、
terms、rerank、scopeChunks、pendingBlocks、annExhaustive。当前候选上限 1000；semantic 对
不超过 10000 个作用域向量做 flat cosine，否则获取 IVF 候选后精确余弦重排。
`exhaustive`／`candidateTruncated` 描述本次索引与候选过程，不保证来源同步或语义答案完整。
`CandidatePresentation` 含 count、policy、comparison、notice；comparison 给 scoreType、top3、
gap12 和阈值。相似度、BM25、关键词覆盖比例不能混作同一种分数或概率。
覆盖类型见存储实现，展示类型见[候选策略](<../src/core/candidates.ts#L25-L54>)。

## 私有 worker JSONL（不稳定）

Host 通过受管子进程的 stdin／stdout 传递逐行 JSON，不监听 HTTP 端口。
每行一个对象，request ID 对应响应；worker 串行执行，无隐式重放。
stdout 专供协议，stderr 被排空但不转发，以免泄露凭据或环境诊断。

```ts
type WorkerRequest = { id: number; method: Method; params: unknown; diagnostics?: boolean };
type Success = { id: number | null; ok: true; value: unknown; timing?: TimingReport };
type Failure = { id: number | null; ok: false; error: { code: string; message: string }; timing?: TimingReport };
interface WorkerReady { type: 'ready'; protocol: 1; pid: number; node: string; lancedb: string }
```

此片段只展示封套；实际 `WorkerRequest` 是 method 与 params 相关联的判别联合。
ready 表示协议已就绪，不表示 store 已配置；每个新 worker 先且仅能 `configure` 一次。

| method | params | value |
| --- | --- | --- |
| `configure` | `{embeddingEnabled: boolean, candidatePolicy?: CandidatePolicy}` | `{configured: true}`；打开库并恢复 journal |
| `sync` | `SyncBatch = {session, messages, blocks}` | `{session, messages: number, blocks: number, changed: boolean}` |
| `checkpoints` | `{sessionIds?: string[]}`；省略为库内全部，空数组为无会话 | `{sessions: SessionRow[]}` |
| `embed` | `{sessionIds?: string[], oneBatch?: boolean}`；运行时要求 ID 数组；`oneBatch` 默认 `false`，为 `true` 时最多补一批 | `EmbedResult = {new, reused, remaining, remainingUnit: "blocks", spaceId}`；`new/reused` 计分块，`remaining` 计未完成的原文块 |
| `search` | `SearchRequest`：query／mode／sessionIds／binding 及可选过滤、limit、cursor | `SearchResult`；不包含 Host 来源附加项 |
| `read` | `Partial<ReadRequest>`，运行时仍要求 ref | `ReadResult`，尚未回读 DSH 核验 |
| `sessions` | `{sessionIds?, query?, offset?, limit?}`；当前运行时要求实际传 sessionIds 数组，limit 为 1–100 | `{sessions, total, offset, nextOffset}` |
| `status` | `{}` | `StoreStatus`，无 Host allowlist 过滤 |

内部 `sessionIds: []` 表示空作用域，不代表 all；该参数不是公开 scope 解析器。
授权由 Host 完成，不能绕过 Host 直连 worker。
合成协议行：`{"id":1,"method":"configure","params":{"embeddingEnabled":false}}` →
`{"id":1,"ok":true,"value":{"configured":true}}`。错误消息经过收敛，不携带原始异常详情。

## 错误码与处理

以下是插件的错误码，不是 DSH 全局枚举；详细消息和内部新增码不稳定。源码见上方的 Host、worker 和桥接入口。

| 代码组 | 处理 |
| --- | --- |
| `CALLER_REQUIRED`、`OUT_OF_SCOPE`、`EMBEDDING_SCOPE_NOT_ENABLED` | 检查调用者与用户配置；不能自动扩大权限 |
| `INVALID_REQUEST`、`NOT_FOUND` | 核对参数、原 blockIndex、ref；空结果不等于未授权历史不存在 |
| `SOURCE_CHANGED` | 停止引用旧结果；检查原事件／checkpoint 不一致，不能降级为“已核验”或强推覆盖 |
| `NOT_PREPARED`、`SYNC_INCOMPLETE` | 前者为 store 未配置／已关闭；后者为中断或恢复不完整。重新初始化／重开恢复后查状态，不忽略 journal 错误 |
| `CURSOR_EXPIRED`、`INVALID_CURSOR`、`SEARCH_CAPACITY` | 前两者重新首查并检查条件绑定；容量满等待快照到期，不篡改游标 |
| `NO_EMBEDDING_CONFIG`、`EMBEDDING_NOT_READY`、`EMBEDDING_CONFIG_CHANGED` | 分别检查凭据、在已授权范围显式 embed、恢复原空间或使用新目录；不自动换模型复用向量 |
| `HTTP_ERROR`、`NETWORK_ERROR`、`INVALID_RESPONSE`、`TIMEOUT`、`ABORTED` | 检查服务与取消状态；嵌入已成功提交的批次可能保留，先查状态再继续 |
| `CLOSED`、`BRIDGE_CLOSED`、`ABORT_ERR`、`REQUEST_TIMEOUT`、`WORKER_INTERRUPTED` | 操作被关闭／取消／超时；后端完成状态可能未知，禁止假定回滚或透明重放 |
| `WORKER_START_FAILED`、`WORKER_EXITED`、`WORKER_EOF`、`WORKER_IO_FAILED`、`WORKER_PROTOCOL_ERROR`、`WORKER_ERROR`、`WORKER_REQUEST_FAILED` | 检查独立 Node、原生库与协议；必要时在确认旧进程退出后重新初始化 |
| `WORKER_SHUTDOWN_FAILED` | 无法确认受管进程范围已静默；禁止启动替代 worker，先解决进程退出问题 |

## Client 最小结构契约（项目内部，不稳定）

设置页只消费公共服务的必要字段；这些是本插件声明，不是完整 Client SDK，也不是私有 HTTP 路由。
设置保存见[配置模型](<../src/client/model.ts>)和[设置页](<../src/client/SettingsPage.tsx>)。

```ts
interface FormSnapshot { status: 'loading' | 'ready' | 'unavailable'; value: unknown; revision: number | undefined; writable: boolean }
interface ConfigForm {
  getSnapshot(): FormSnapshot;
  subscribe(listener: () => void): () => void;
  mutate(ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<boolean>;
}
interface SessionListSnapshot {
  ids: readonly string[];
  byId: Readonly<Record<string, SessionListItem | undefined>>;
  phase: 'pending' | 'ready';
}
```

`configForms.describe()` 提供 namespaces 的 `{ns, value, revision}` 及 writable；
`configForms.get(entryId)` 提供表单镜像。保存以一次 `mutate` 提交完整草稿的 set／unset 操作及编辑基线 `expectedRevision`；
`false`／异常表示拒绝，不应强制覆盖。缺少布尔 `autoEmbed` 的旧快照不写入；从关切到开须确认外发，即使沿用原授权。凭据只保存文件路径，不把 key 放入设置表单。
`settings.section` 的 props 提供 `useSessions(selector, equality?)`；会话项只使用
`id/displayTitle/title?/cwd?/origin?` 元数据，`origin: "subagent"` 从可选主会话中排除。
该 hook 不 retain／打开会话，也不搜索消息正文；不能把内部 manager 的 items／state／error 当公共字段。
语料和嵌入选择各自独立；UI 保留缺失已选 ID 供移除，不因列表暂缺而自动清空或扩权。
