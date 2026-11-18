# 架构、数据流与生命周期

本文面向修改或集成本插件的开发者，描述当前源码的职责边界与资源所有权。
工具参数、返回类型和配置字段见[接口参考](<api.md>)；环境准备与合成测试见[开发引导](<development.md>)。
本文不把检索候选视为事实，也不把派生索引视为 DSH 会话的替代品。

## 1. 三层架构

```text
┌─ Client：设置页 ────────────────────────────────────────────┐
│ Slot + locale + configForms + 会话列表元数据 selector        │
│ 编辑配置草稿，不读取会话正文、不运行 LanceDB、不请求 embedding │
└──────────────────────┬────────────────────────────────────┘
                       │ DSH 共享设置文档 / revision
┌─ Host：插件实例与运行代次 ──────────────────────────────────┐
│ Config → 权限与 scope → 四个工具 → 同步 / 原文回读校验        │
│ sessionQuery / sessions / 可选 sessionPersistence            │
│ committed events → dirty set → 256-event tail batches        │
└──────────────────────┬────────────────────────────────────┘
                       │ 独立 Node，stdin/stdout JSONL
┌─ Worker：串行存储与检索 ────────────────────────────────────┐
│ journal → messages / blocks → sessions checkpoint            │
│ chunking → 显式授权 embedding → vectors / embedding_progress │
│ exact / fuzzy / semantic → 有界候选 → 搜索快照               │
└───────────────────────────────────────────────────────────┘
```

Client 通过 DSH 的设置服务保存配置，不直接调用 worker。
Host 持有 DSH Service 引用；worker 只接收投影后的数据，不持有 DSH Session 或 Service。
LanceDB 与 embedding 客户端在独立 Node 中加载，不在 DSH Host 进程内加载原生数据库。
入口、导出和 Client 声明由[包清单](<../package.json>)连接。

## 2. 模块职责与单一事实源

| 模块 | 职责 |
| --- | --- |
| [Host 入口](<../src/host/plugin.ts>) | 配置代次、工具注册、调用者与语料权限、同步调度、原文校验、关闭屏障。 |
| [配置](<../src/host/config.ts>) | 声明可序列化字段、规范化 ID、校验路径与 embedding 子集、读取 volatile 引用。 |
| [同步器](<../src/host/sync.ts>) | 选择 live/cold 读取路径、校验 checkpoint、顺序读取事件尾部并投影。 |
| [进程桥](<../src/host/bridge.ts>) | 启动与 ready 握手、请求 ID、错误收敛、取消、进程范围退出确认。 |
| [worker 入口](<../src/worker/main.ts>) | JSONL 分派、一次 configure、串行操作、EOF 后关闭存储。 |
| [存储](<../src/storage/store.ts>) | 表结构、写前 journal、恢复、幂等写入、索引、embedding 进度、检索和回读。 |
| [文本投影](<../src/shared/session-text.ts>) | 从已提交事件抽取合格的原始发言及可见附件引用。 |
| [核心算法](<../src/core/chunking.ts>)、[候选展示](<../src/core/candidates.ts>)、[分页](<../src/core/cursors.ts>) | 原文分块、展示数量策略、绑定查询的快照 cursor。 |
| [embedding 客户端](<../src/embedding/client.ts>) | OpenAI 兼容请求、超时、响应向量校验、向量空间标识。 |
| [Client 入口](<../src/client/settings.ts>)、[设置页](<../src/client/SettingsPage.tsx>)、[草稿模型](<../src/client/model.ts>) | 注册页面、订阅共享状态、选择会话与提交 revision 化草稿。 |

DSH 已提交的会话日志是原始发言的事实源。
本地 `messages`、`blocks`、向量和 checkpoint 都是可重建的派生数据；插件不修改原始会话日志。
存储中的完整可见消息位于 `messages.contentJson`，完整可检索文本位于 `blocks.text`。
向量行保存定位字段、范围、hash 和向量，不保存完整语料正文副本。
源 checkpoint 只由 `sessions` 表中的会话行代表，最后写入，不能由向量进度推断。
数据形状集中见[共享模型](<../src/shared/model.ts>)和[内部协议](<../src/shared/protocol.ts>)。

同一会话的同步操作经同步器排队，不并发推进同一个 checkpoint。
worker 的 `for await` 分派循环等待当前操作结束后再处理下一行；所有存储操作串行执行。
一个长 embedding 操作因此可能阻塞后续 worker 读取，插件没有为读写请求另设并行队列。
每个数据目录应由一个插件实例使用；串行 worker 不等于跨实例目录锁。

## 3. 语料发现与事件尾部同步

### 发现与授权

`sessionIds` 决定可索引语料，`callerSessionIds` 决定谁能调用工具；两者不是同一授权。
显式 ID 列表直接作为候选范围；`["all"]` 通过 `sessionQuery.listSessions()` 发现逻辑会话。
归档主会话和用户派生会话可在配置语料内；无论显式 ID 还是 all，同步时均跳过 `origin: subagent` 或正的 delegation depth。
`scope: current`、单会话 ID 与 `all` 都只能在既有配置范围内解析，不会扩大配置授权。
Client 的会话选择器是另一条元数据通道，不是 Host 语料发现或正文索引。

### 读取路径

[同步器](<../src/host/sync.ts>)先取 worker checkpoint，再选择来源：

1. **live**：通过 `sessions.get(id)` 判定后，取得 `observeSession(id, { projectionMode: 'none' })` 租约。
   租约提供固定观察切面的 header、继承事件数量、events 和 cursor；读取不追逐后续追加。
2. **cold 且有持久化服务**：`sessionPersistence.open(id, 'read', { signal })`，按事件 offset/length 读取。
   只持有读句柄，不申请写所有权，不恢复或启动 Agent。
3. **兼容回退**：缺少持久化服务时使用 `sessionQuery.readSession(id)`，获得完整日志快照后切片。

退出同步时在 `finally` 中释放 observation，并关闭持久化句柄。
租约/句柄的公开读取契约不保证底层按字节范围读取；live 观察本身可持有完整事件集合，回退明确全物化。
因此每批 256 个事件只约束插件投影与发送的批量，不等于整个读取链路恒定内存。

### 增量与提交

```text
listSessions / 配置 ID
  → 观察租约或读句柄
  → checkpoint(cursor, anchorHash) 与源事件核对
  → 从 cursor + 1 读取至多 256 个连续事件
  → 原始可见消息投影 → sync JSONL
  → flushed journal intent → messages → blocks → sessions checkpoint
  → done 标记；继续下一批
```

已有 checkpoint 必须能在来源找到同 seq 且 hash 相同的锚事件，否则报 `SOURCE_CHANGED`。
每批事件还校验从预期 offset 开始且 seq 连续；最后一个事件的 hash 成为新锚点。
标题从 `session/title` 事件折叠，checkpoint 即使没有新增正文也可更新元数据。
锚点用于发现被处理边界的变化，不是对每次同步前的全部历史重新做完整 hash 审计。

[存储写入](<../src/storage/store.ts>)先验证批次、已有行与 checkpoint 的一致性。
完整 intent 先写入并 flush 临时文件，再发布为可恢复 journal；随后幂等 upsert 消息与文本块。
只有前两类行写入后才推进 `sessions` checkpoint，最后写 done 标记。
启动时重放没有 done 标记的完整 journal；不完整临时文件不当作已发布 intent。
写入中断会使当前 store 拒绝继续操作，重开后经过恢复再使用，不以部分结果冒充同步完成。

## 4. 文本投影与分块

[投影函数](<../src/shared/session-text.ts>)只接受以下原始来源：

- `user/message` 中 role 为 user、source kind 为 user，且不是 relay 的消息。
- `assistant/message` 中 role 为 assistant、source kind 为 model 的消息。

带对象形式 `surfaceOp` 的 replacement 消息不作为原始发言收录。
system/developer/tool、reasoning、工具调用、未提交流片段和其他非合格来源不成为检索正文。
这是原始发言档案投影，不是“当前模型 surface”的重新渲染；后续摘要不会取代原始发言。
保留文本与 image/file 引用、原始 `blockIndex`、message ID、source kind、provider/model 与 inherited 标记。
附件引用不等于附件字节；图片不做 OCR，文件内容不展开进文本索引。

消息 ref 由会话 ID 与事件 seq 组成，文本块再使用原始 block index 定位。
[存储规范化](<../src/storage/store.ts>)为文本块计算 hash 和去重键，并拒绝已存在定位下的内容变更。
分块只服务于 embedding：全文文本块仍用于 exact 与原文回读，不被 chunk 替代。
[分块算法](<../src/core/chunking.ts>)优先段落、再句子/换行、最后硬切，保留原文分隔符。
块大小按 Unicode code point 计算，定位 `start/end` 使用 UTF-16 code unit；二者不能互换。
`chunkingVersion`、原文 hash 和 embedding space 一起限定向量及完成进度的有效性。

## 5. 检索、分页与来源验证

### 候选检索

[Host 工具实现](<../src/host/plugin.ts>)在首轮搜索前尝试同步目标范围，单次前台最多选择 20 个会话。
其余会话在启用 autoSync 时进入后台队列；结果携带同步错误和 deferred 信息，不能假定全范围已追平。
后续 cursor 页直接读取既有候选快照，不再次同步或生成 query embedding。

[检索实现](<../src/storage/store.ts>)在数据库候选选择前施加 session、role 与时间硬过滤：

- **exact**：完整文本块的字面子串匹配，不依赖 tokenizer 找全。
- **fuzzy**：空白分隔的无序关键词经全文索引召回，再检查原文关键词；不是编辑距离算法。
  至少一个词可命中，按匹配词覆盖率、BM25 和稳定顺序排列，不保证每个词都出现。
- **semantic**：用 query 向量检索已授权范围中的向量，并按精确 cosine 重排候选。
  较小范围使用 flat cosine；较大范围使用 IVF-flat 召回，重排不使 ANN 召回变成穷尽搜索。

候选上限当前为 1000；搜索 excerpt 至多 800 个 UTF-16 单位，不能代替完整原文。
结果提供 coverage、pending 和截断信息；展示数量由[候选策略](<../src/core/candidates.ts>)决定。
相似度和单候选展示阈值是检索启发式，不是事实正确率或概率。

### Cursor 所有权

[worker 分页器](<../src/core/cursors.ts>)为一次排序结果创建快照，以 HMAC 绑定实例、快照、offset 和查询 binding。
[Host](<../src/host/plugin.ts>)再包裹调用者、请求 scope、query/mode/role/time 与固定会话集合。
两层 cursor 都有实例边界与有效期；默认有效期为 30 分钟，重启或配置代次更换后应重新搜索。
继续分页不重新 embedding，也不会因为新增消息悄悄改变当前快照的顺序。
搜索快照落盘，但当前实例仍用内存中的快照与密钥验证；它不是跨重启可恢复的分页协议。

### 原文回读

`chat_recall_read` 首次按配置同步目标会话，由 worker 返回文本页、附件引用和至多前后各 3 条消息。
Host 随后通过 `sessionQuery.readEvent` 回到 DSH 原始事件，而不是仅相信本地索引。
目标文本块须满足合格来源、role、完整块 SHA-256 与返回页子串一致，附件引用字段也逐项核对。
成功后才返回 `verified: true` 与来源定位；不一致报 `SOURCE_CHANGED`，不悄悄改用缓存。

邻居消息每条共享 4000 个 UTF-16 单位的文本预算；超出部分截断为有界前缀。
Host 验证邻居来源、role、附件以及每个已返回文本前缀，但不计算整个邻居文本的完整块 hash。
因此邻居的 verified 只覆盖返回字段/前缀，不证明未返回后缀未变化，也不证明历史陈述是真的。
长目标文本用 read cursor 继续，保留目标 block 与 offset；续页不重复邻居上下文。
UTF-16 分页避免切断代理对；返回页有限不代表底层只读取该页字节。
DSH 的 `readEvent` 可读取或准备完整日志，接口没有承诺 byte-range 或流式正文传输。
所有历史文本均为引用数据，不能被调用方当作新的系统、开发者或用户指令。

## 6. Embedding 授权与请求边界

本地文本授权与外发授权分开：`embeddingSessionIds` 必须在非空配置语料内生效。
其中 `["all"]` 表示覆盖配置语料，不表示所有 DSH 会话；任何工具 scope 都不能扩大它。
显式 `chat_recall_status` 的 `embed` 动作和单会话 semantic 首查可补齐缺失向量；这两条外发路径不依赖 `autoEmbed`，仍受外发授权限制。
多会话 semantic 搜索使用已有向量；coverage 反映 pending。
非空可搜索向量范围的 semantic 首次查询还会发送 query；继续 cursor 页不发送 query。

[worker](<../src/worker/main.ts>)仅在 configure 允许 embedding 时构造 embedder，从自身环境读取配置。
可选 env-file 只作为 Node 启动参数交给 worker，不经 JSONL 传输其内容。
[embedding 客户端](<../src/embedding/client.ts>)发送 `model`、`input`、float 格式和可选 dimensions，凭据放 Authorization header。
正文请求不附带会话元数据，但用户文本本身可能包含敏感信息；目的服务由部署配置决定。
HTTP 禁止 redirect，校验返回索引、数量、维度与有限数值；错误不保留响应体或原始异常原因。
endpoint/model/dimensions/编码共同定义 space；改变空间不会静默混用既有向量。
[存储](<../src/storage/store.ts>)每个成功的远程批次先提交向量，再在整块完成时提交进度。重试复用已提交的分块；进度索引维护失败也不抹去提交结果。

## 7. Host 配置与运行代次

[配置 schema](<../src/host/config.ts>)将字段声明为 volatile，运行时读取 `get()` 引用并复制为普通值快照。
它只把数据型 schema 投影给设置页；跨字段权限约束仍由 Host 校验，Client 校验不是授权边界。
[Host apply](<../src/host/plugin.ts>)持有稳定父实例；可选 settings 服务通过 `configure({ auto: false }, parentFiber)` 关闭重复自动表单。
每个 child fiber 持有一个运行代次的工具、事件监听、同步器、dirty 队列、timer、bridge 和 cursor 密钥。

```text
初始 Config 快照 → mount child fiber → applyRuntime
volatile values 提交 → loader/volatile-update → 新快照 / revision + 1
  → 旧代次 close：同步置 closing、abort、清 timer、关闭 bridge
  → 等待旧 close 与 child dispose → 仅当前 revision 可 remount
父实例 dispose → 禁止新 mount → 退役当前代次并等待在途 transition
```

close 同步设置 fence，使仍被外部持有的旧工具回调不能继续使用旧配置。
代次 revision 也覆盖异步 child 激活竞态；过期代次不能在稍后重新挂载。
关闭失败不启动替代代次；快速连续配置变化只允许最终有效版本 mount。
Loader 同步 emit volatile 通知，不等待插件的异步 transition；配置保存成功不等于新 worker 已 ready。
transition 关闭失败后保持 fail-closed，后续保存不恢复该链；需重新装载插件入口或重启，再检查可用性。
无完整 Cordis 生命周期的嵌入上下文可直接使用 `applyRuntime`，此时调用方负责其返回的 close。

## 8. DSH hooks 与后台同步

| 入口 / hook | 当前插件行为与所有权 |
| --- | --- |
| `apply` / `ctx.plugin` | 创建稳定父实例与运行 child，配置更新按代次退役。 |
| `loader/volatile-update` | 读取已提交的新引用值，close 后 remount，不原地混用配置。 |
| `session/event`（emit） | 只把合格语料的 user/assistant、turn/end、title 事件标 dirty；不在监听器中读全日志或请求 embedding。 |
| `session/flush`（parallel） | DSH 的 awaited durability checkpoint；本插件没有注册该 hook，也不把索引完成等同于 DSH flush。 |
| autoSync 初始化 / timer | 发现配置语料，250 ms 合并调度，每次 drain 处理一个 dirty 会话并记录错误。 |
| `ctx.effect` cleanup | 置 closing、abort 当前代次、清 timer，等待 bridge 与同步任务结束。 |

`session/event` 是提交后的 fire-and-forget 通知，不是可阻止提交的 waterfall。
关闭 `autoSync` 停止后台回填和事件入队，不影响工具按需同步。
插件不监听逐 token assistant stream，也不通过 Agent 生命周期去恢复会话来做索引。

后台队列每会话至多一条。启用 `autoEmbed` 后，只为同时获本地与外发授权且文本同步成功的会话补向量：启动查积压，新增合格正文也会入队，工具前置同步不等待后台补齐。后台沿用 worker 分批，每次最多发送 32 个缺失分块，有剩余就排回队尾。

补向量失败记入 `autoEmbedErrors`，不回退文本 checkpoint，也不定时重试。合格新正文、重新加载启用配置或显式 `embed` 可再尝试；只有标题或轮次变化不触发重试。关闭自动补齐或收回授权会取消旧代次并等待退出屏障；已发请求无法撤回。

## 9. Bridge、取消与退出屏障

[bridge](<../src/host/bridge.ts>)懒启动独立 Node，ready 协议握手后才写请求，response 由数字 ID 匹配。
JSONL 的方法与结果类型见[内部协议](<../src/shared/protocol.ts>)；它没有隐式重放和逐请求 cancel 消息。
外部 abort 或请求超时会先拒绝对应 Promise；已属于某个 run 的请求还会中断整个 worker run。
因此并发等待同一 worker 的其他请求也可能失败；不能把 abort 描述成仅取消一条数据库查询。

关闭先永久标记 bridge closed，并拒绝所有 pending；同一个 close Promise 可重复等待。
正常关闭先结束 stdin，让 worker 串行消费已收到的输入并在 EOF 的 `finally` 关闭 store。
超过宽限期或发生故障则调用 subprocess handle 的 `terminate()`，按 provider 管理范围终止。
`handle.done` 只表示直接命令的退出事实，不足以证明其后代或整个管理范围已安静。
独立的 `waitForExit()` 才用于确认同一管理范围退出；两者都完成才允许关闭成功或后续替代 worker。
若 provider 无法确认范围退出，bridge 保留 shutdown failure，并阻止再启动，不将直接退出误报为清理成功。
stderr 被排空但不保留或转发，避免把环境诊断、凭据或原始进程异常带到工具结果。

## 10. Client effects、React hooks 与草稿

[Client 入口](<../src/client/settings.ts>)在 apply 内通过 `ctx.effect` 注册 locale，通过 `slots.inject` 注册设置 Slot。
这里的 Client effect 是资源生命周期，不是额外业务 Service；Slot 移除/插件卸载会回收其注册。
构建器只生成模块 factory；React/ReactDOM 由 DSH 共享，见[Client 构建器](<../scripts/build-client.ts>)。
页面样式随 React 元素挂载，不另建应用根节点；locale snapshot 变化触发页面重新取翻译。

[设置页 hooks](<../src/client/SettingsPage.tsx>)以 `useSyncExternalStore` 订阅 form、describe mirror 与 locale，卸载时退订。
会话列表使用 Slot 提供的 `useSessions(selector, equality)`，只投影 ID、标题、cwd 等元数据，不 retain Session。
草稿独立于已接受配置：干净草稿可跟随新 revision，脏草稿或被拒绝草稿不会被后台刷新覆盖。
保存使用一次 `form.mutate(ops, expectedRevision)`；拒绝保留草稿，用户可显式重载或 rebase。
mounted 标记阻止异步保存完成后更新已卸载组件，saving 标记阻止重复提交。

本地语料与 embedding 选择分别编辑；权限扩张/外发范围或目的配置变化要求对应确认。
缺失或不在列表中的已选 ID 仍保留为可移除项，不因列表变化而自动清空或扩大授权。
[Client 最小契约](<../src/client/contracts.ts>)只是本插件所消费的结构，不是 DSH 全部 API 的复制或跨版本保证。
集成时需对实际安装的 settings、locale、Slot props 和 disposal 契约核验，不能只凭本地接口通过类型检查。

## 11. 保留、覆盖与运行边界

缩小语料、关闭外发授权、关闭 `autoEmbed`／`autoSync` 或卸载插件都不自动删除已有本地索引、向量或 journal。
搜索 cursor 的 TTL 使分页失效，不等于删除已落盘的搜索快照；done journal 也没有自动清理策略。
停用授权不会删除已有会话中的工具输出。
数据目录是持久派生数据，不是随 fiber 释放的临时资源；物理清理需由部署方单独管理。

状态中的全库计数描述本地存储，而非某次查询的授权覆盖；使用返回的 scope、checkpoint、pending 和截断信息判断范围。
有界批次、候选上限和索引只描述当前实现，不构成百万级语料、恒定内存、端到端延迟或所有平台原生依赖的保证。
公开测试应使用合成日志与可注入 embedding/mock 边界，不依赖真实个人会话或密钥；运行方法见[开发引导](<development.md>)。
