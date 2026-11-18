# dsh-chat-recall

DeepSeek Harness（DSH）的对话原文检索插件，提供精确子串、无序关键词和语义检索，以及可分页、经原事件核验的原文读取。DSH会话日志是事实来源，本地LanceDB只是派生索引。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [架构与数据流](<docs/architecture.md>) | Host、worker、Client的职责，索引与查询路径，生命周期钩子及资源所有权 |
| [开发指南](<docs/development.md>) | 环境、构建、源码导览、测试、打包和安全约束 |
| [接口与类型参考](<docs/api.md>) | 配置、四个工具、结果类型、内部JSONL协议与数据模型 |

文档描述当前仓库源码。已安装插件的功能取决于其构建版本；修改工作区不会更新正在运行的Host或Client。

## 能力与边界

- **原文检索**：exact匹配完整文本块中的子串；fuzzy按完整查询词覆盖和BM25排序；semantic按余弦相似度召回并重排候选。
- **来源核验**：搜索结果只是候选。`chat_recall_read`逐页回读DSH事件，检查文本与附件引用；不把缓存摘要当作原话。
- **增量索引**：按会话保存checkpoint与事件anchor，处理提交后的尾部；中断写入通过journal恢复。
- **分页**：搜索使用有界结果快照，原文使用UTF-16偏移；续页不重新发起embedding。
- **独立授权**：本地索引与语义外发分别配置，默认均为空。支持归档主对话与用户fork，不包含子agent内部会话。
- **原生设置入口**：在DSH「设置 → 对话回溯」编辑草稿，通过共享配置服务和revision校验原子保存。Client使用TSX、shadcn/ui Base UI和宿主主题。

不提供附件OCR、图片/PDF内容embedding、独立搜索网站或经过校准的自动拒答。候选分数不是事实正确率。索引、journal和搜索快照可能保存聊天文字，不会自动删除，需管理磁盘容量与目录权限。

## 运行要求

- 独立Node.js **≥22.6**，推荐Node 24 LTS；该可执行文件必须允许加载第三方原生模块。DSH本身的Node版本要求另以其发行版为准。
- DSH版本约束见[包清单](<package.json>)；Host使用公开服务接口，Client需要Web设置页和locale服务。
- 可加载当前平台LanceDB原生包的环境。Host不加载LanceDB，数据操作在受管理的独立Node进程中执行；macOS签名运行时的Library Validation可能阻止Host直接加载第三方原生库。

不需要另起HTTP服务，不修改DSH签名或系统安全配置。仓库为私有包标记，不通过npm自动发布。

## 构建与安装

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm run typecheck
pnpm test
pnpm run build
```

通过DSH插件管理器安装构建包或包目录。安装源码目录前必须先build；如果以链接方式安装，运行期间需要保留构建产物。可移植安装包的准备方式见[开发指南](<docs/development.md#构建与分发>)。更新Host代码后需要完整重启DSH，不能把浏览器刷新当作Host模块已重载。

安装后在DSH设置页选择本地语料范围。仅使用exact/fuzzy时可保持语义外发关闭，无需embedding凭据。最小配置示例：

```yaml
nodePath: /absolute/path/to/node
sessionIds: []
embeddingSessionIds: []
autoSync: true
```

需要semantic时，另行选择允许外发的语料并设置`envFile`绝对路径。环境文件使用`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_EMBEDDING_MODEL`和可选的`OPENAI_EMBEDDING_DIMENSIONS`。只填写路径，不把密钥写进仓库、聊天或浏览器表单。配置的准确默认值和校验规则见[接口参考](<docs/api.md>)。

### 自动补向量（默认关闭）

开启自动本地索引、选定非空外发范围并配置可用的 embedding 服务后，在「设置 → 对话回溯 → 后台同步」开启「自动补向量」，确认外发后保存。后台也会补齐已授权语料的历史缺口；**正文会发给服务商，可能产生费用**。用 `chat_recall_status` [查看进度和错误](<docs/api.md#公开-agent-工具>)；后台行为见[架构](<docs/architecture.md#8-dsh-hooks-与后台同步>)。

## 工具概览

| 工具 | 用途 |
| --- | --- |
| `chat_recall_search` | exact、fuzzy、semantic候选检索，支持会话、角色、时间过滤与cursor |
| `chat_recall_read` | 读取并核验命中原文、附件元数据和有限邻居，支持长文续页 |
| `chat_recall_sessions` | 发现配置范围内的会话，支持标题筛选和分页 |
| `chat_recall_status` | 查看覆盖与向量进度；显式同步文本或补齐允许范围内的向量 |

单会话 semantic 首查可补齐允许外发的缺失向量；多会话查询只用已有向量。exact、fuzzy、原文读取及 cursor 续页不直接请求 embedding。

搜索快照最多1000个候选；cursor绑定调用者和查询条件，30分钟过期，运行实例重启后失效。ANN结果不保证穷举。DSH公开读取接口内部可能物化完整事件数组或解码压缩日志，插件的增量提取不等于底层字节范围读取。详见[架构边界](<docs/architecture.md>)。

## 测试与数据

```bash
pnpm run format:check
pnpm run check:docs
pnpm test
```

默认回归使用合成对话、合成向量和本地HTTP fixture，不读取真实DSH会话或凭据，也不调用付费服务。合成对话说明见[测试fixture](<test/fixtures/README.md>)。可选的外部文本诊断与常规回归分开，数据和权限说明见[评估输入](<evaluation/README.md>)。

## 第三方组件

LanceDB运行时复制与许可校验见[开发指南](<docs/development.md#构建与分发>)。Client的shadcn/ui改编来源、Base UI及共享React边界见[Client NOTICE](<src/client/NOTICE.md>)；[shadcn MIT许可](<src/client/SHADCN_LICENSE.txt>)和[LanceDB Apache许可](<licenses/lancedb-Apache-2.0.txt>)随源码保留。构建会附带实际内置依赖的第三方许可。
