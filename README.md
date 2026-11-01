# dsh-chat-recall

DeepSeek Harness 的原话回溯插件：**精确子串、无序关键词、语义检索**，支持增量同步、段落分块、自适应候选与原文分页核验。

## v0.2 已实现

- **原文保真分块**：优先段落、句尾和换行；目标600 codepoint、最大720；合并短尾，不改文字、不拆Unicode surrogate。
- **自适应候选**：语义排名领先明显时只返回一条正文，附前3名分数；分数接近时返回3–5条。余弦分数不是正确率，不自动判定无答案。
- **增量同步**：每会话进度和事件anchor校验，处理新增尾部；journal重放，checkpoint最后提交，embedding独立进度。
- **分页**：搜索快照固定顺序，续页不重新embedding；长文逐页回读DSH原事件核验。游标绑定调用者/条件，过期明确报错。
- **源身份去重**：继承的同来源发言合并，独立的相同文字不合并；保留原角色、事件和block位置。
- **可控范围**：当前、指定会话或已配置全局；包含归档主对话和用户分叉，排除子agent内部。

## 安装前

需要 **Node >=22.6（推荐24 LTS）**，且该可执行文件必须允许加载第三方原生模块。LanceDB固定0.41.0；DSH随附的签名Node在本机不能加载该原生库，因此插件用DSH纯JS Host管理独立Node子进程。不修改签名、不起HTTP服务器、不使用SQLite。

通过DSH插件管理器安装本包。默认不索引任何历史，也不发送embedding请求。

配置最小示例：

```yaml
nodePath: /absolute/path/to/node
sessionIds:
  - session-...
embeddingSessionIds: []
autoSync: true
```

若要语义检索，另行配置 `embeddingSessionIds` 和绝对路径 `envFile`。本地env文件包含 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_EMBEDDING_MODEL`、可选 `OPENAI_EMBEDDING_DIMENSIONS`。**不要把密钥发到聊天或提交Git。**

完整配置、工具和边界见 [使用文档](<docs/production.md>)。

## 工具

| 工具 | 用途 |
|---|---|
| `chat_recall_search` | exact / fuzzy / semantic 搜索；可指定scope、role、时间范围，带nextCursor |
| `chat_recall_read` | 原话与邻居回读；长文nextCursor；文本页逐字核验 |
| `chat_recall_sessions` | 查找配置语料内的会话 |
| `chat_recall_status` | 查看覆盖、同步失败与向量进度；显式sync/embed |

语义初次单会话查询会补齐允许范围内的缺失向量。跨会话查询使用已有向量；可先分范围执行status/embed。原文中的路径/URL作为文字可能进入embedding，附件字节、图片、PDF内容、reasoning和工具结果不会上传。

## 候选展示规则

默认有至少3个候选，并且 `top1 >= 0.50`、`top1-top2 >= 0.15` 时，只展示首条正文，同时显示前三名分数。否则返回3–5条，显式limit可以覆盖。被省略的正文仍能翻页读取。

阈值是**展示启发式**，没有被校准成“有答案”的裁决。无关问题仍可能返回低分候选，回答前必须核对原文。

## 验证

本机回归覆盖真实LanceDB、故障恢复、增量embedding、源身份去重、Unicode、候选分页与Host→worker链路。真实DSH已验证指定会话150条原话索引、重复同步零增量、搜索续页与原文核验。

在此前冻结的25条真实消息上，段落分块由31块变为30块；同样5个正例预期名次为 **3、1、1、2、1**，均在前三。两个无关问题仍返回不相关候选，没有当作成功拒答。重开后30块全部复用；翻页没有重新embedding。

这只是受限样本验证，不是全局真实召回保证。详细结果见仓库内 [v0.2验证记录](<docs/production-validation.md>)。

## TypeScript 源码与开发

仓库只保留正式 [TypeScript源码](<src/>)、[TypeScript测试](<test/>) 和 [TypeScript开发工具](<scripts/>)，不再保留旧JS实现、兼容转发或实验入口。功能与索引格式不变。

建议先读 [数据模型](<src/shared/model.ts>) → [进程通信契约](<src/shared/protocol.ts>) → [Host入口](<src/host/plugin.ts>)；完整目录导览见 [开发与阅读指南](<docs/development.md>)。

```bash
pnpm run typecheck
pnpm test                 # 临时构建、检查TS测试、回归，结束自动清理产物
pnpm run format:check
pnpm run build           # 仅安装前需要，生成dist
pnpm run clean           # 删除生成的dist，不碰索引和凭据
```

测试使用可加载LanceDB的独立Node，仅操作合成数据/本机模拟HTTP，不读取密钥。可用 `RECALL_TEST_NODE` 指定子进程Node路径。测试源码也是TS，仍验证临时编译的JS产物，完成后自动清理。

生产源码入口是 [plugin.ts](<src/host/plugin.ts>)。DSH运行包仍需要构建出的JS；[包清单](<package.json>)通过prepack构建、postpack清理，仅分发正式TS源码、编译产物和文档，不保留源码树里的生成文件。

**本轮清理已卸载指向旧源码目录的本地插件链接包**，避免留下损坏入口。原聊天索引和凭据未删除；当前未启用回溯插件。再次使用时先构建并安装正式包，再配置所需会话范围。若链接安装本仓库，保持构建产物直到卸载；想同时保持仓库无产物，应安装打包文件而不是源码目录。

## 已知边界

- 搜索候选快照最多1000条；局部<=10000向量用flat，大范围ANN候选后精确余弦重排，披露截断和非穷举。
- 游标30分钟过期、进程重启失效；不伪装自动恢复。
- journal与快照保留本地，不自动删除，磁盘会增长。
- 公共DSH读取API内部仍可能物化完整事件数组／解码压缩日志；增量保证针对提取、传输和索引，不宣称底层字节范围读取。
- 没有独立搜索页面、附件内容提取、可靠自动拒答或百万高维真实质量证明。
- 不自动迁移旧实验数据库，不自动扩大索引/外发范围，尚未发布npm。
