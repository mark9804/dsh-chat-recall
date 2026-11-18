# 开发指南

本指南面向修改源码、增加测试或维护DSH集成的人类开发者。[架构文档](<architecture.md>)解释运行机制，[接口参考](<api.md>)给出参数、数据类型和协议边界。

## 环境与首次运行

使用支持TypeScript type stripping且可加载LanceDB原生模块的Node.js，最低版本见[包清单](<../package.json>)，推荐Node 24 LTS。DSH Host与检索worker是不同进程，不能因为Host能启动就假设它能加载原生数据层。使用pnpm与现有锁文件，不需要ts-node或tsx运行器。

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm run typecheck
pnpm run format:check
pnpm run check:docs
pnpm test
```

`--ignore-scripts`不批准依赖安装脚本。平台原生包与esbuild由声明的依赖解析；若环境不满足，先查明缺失的包或平台支持，不修改系统安全设置来绕过。`RECALL_TEST_NODE`可显式指定测试runner和测试子进程使用的独立Node绝对路径。

## 源码地图

| 入口 | 职责 |
| --- | --- |
| [Host插件](<../src/host/plugin.ts>) | 配置代次、工具注册、授权、同步调度、原事件核验和清理 |
| [Host配置](<../src/host/config.ts>) | Schemastery字段、volatile值、校验和不可变运行时快照 |
| [DSH Host窄契约](<../src/host/contracts.ts>) | 实际使用的DSH服务与事件最小结构类型，不是完整SDK |
| [会话同步](<../src/host/sync.ts>) | 目录、观察租约、只读持久化句柄、anchor和尾部批次 |
| [进程桥接](<../src/host/bridge.ts>) | ready握手、JSONL请求、取消、超时和范围退出确认 |
| [worker入口](<../src/worker/main.ts>) | 协议校验、串行请求分发、环境配置与store生命周期 |
| [存储实现](<../src/storage/store.ts>) | LanceDB表、journal恢复、检索、向量进度与索引维护 |
| [共享数据模型](<../src/shared/model.ts>) | 来源行、完整文本块、命中、覆盖与embedding接口 |
| [worker协议](<../src/shared/protocol.ts>) | 方法到参数／结果的类型映射，JSONL envelope |
| [来源提取](<../src/shared/session-text.ts>) | 从用户／模型事件提取文本和附件引用，排除工具／替换来源 |
| [分块](<../src/core/chunking.ts>) | 保留原文、UTF-16区间和段落优先边界 |
| [候选策略](<../src/core/candidates.ts>) | 可配置的语义候选展示规则，不负责判断答案真伪 |
| [搜索快照](<../src/core/cursors.ts>) | 固定候选、签名cursor、TTL、容量和调用者绑定 |
| [embedding客户端](<../src/embedding/client.ts>) | OpenAI-compatible协议、空间身份、批处理、取消和响应校验 |
| [Client入口](<../src/client/settings.ts>) | ModuleLoader导出、locale与settings.section贡献 |
| [设置视图](<../src/client/SettingsPage.tsx>) | 共享配置订阅、草稿、显式授权与revision保存 |
| [设置纯模型](<../src/client/model.ts>) | 字段校验、授权差异、元数据过滤与50条分页 |
| [基础控件](<../src/client/ui.tsx>)、[shadcn组合](<../src/client/shadcn.tsx>) | Base UI包装与组合 |
| [局部样式](<../src/client/styles.css>) | 插件根作用域、宿主主题token与响应式布局 |

首次阅读建议：共享模型 → Host入口 → 会话同步 → store → worker协议与桥接。修改某个功能时沿实际调用链阅读，不把内部worker方法当作公开DSH服务。

## 类型与运行时边界

- [Host类型配置](<../tsconfig.json>)：strict、NodeNext ESM、ES2022和Node库类型；输出JavaScript、声明与source map，不编译Client。
- [Client类型配置](<../tsconfig.client.json>)：strict、Bundler解析、react-jsx和DOM类型，noEmit；实际打包交给esbuild。
- [测试类型配置](<../tsconfig.test.json>)：覆盖源码、测试和开发脚本。测试依赖临时编译产物，单独执行此检查前需先build。
- DSH最小契约只记录插件依赖的结构；升级DSH时重新核对公开API与事件语义，类型通过不等于运行契约已经验证。
- JSONL、HTTP JSON、DSH事件与Arrow行仍需运行时检查。不要用类型断言代替权限、范围、来源或协议验证。

## 构建与分发

```bash
pnpm run build
pnpm run check:package
# 需要制作安装包时才执行：
pnpm pack --pack-destination /absolute/path/to/output
```

构建由三部分组成：

1. TypeScript编译Host、worker与共享模块。
2. [Client构建脚本](<../scripts/build-client.ts>)把TSX和Base UI构建为classic `window.__ModuleLoader__.load(...)`工厂，CSS作为文本由组件渲染。仅external宿主`react`、`react-dom`和`react/jsx-runtime`；拒绝把第二份React打入包。
3. [LanceDB分发脚本](<../scripts/build-vendor.ts>)复制上游运行时代码及许可，保留原生加载器。完整LanceDB包仅用于开发构建；运行依赖使用Arrow、OpenTelemetry、reflect-metadata和平台原生包，不引入其可选模型SDK。

Client构建按esbuild metafile收集实际内置依赖的许可，生成第三方notices和哈希／输入元数据。[包边界检查](<../scripts/check-package.ts>)验证Host原生依赖隔离、worker入口、classic Client格式、共享React、许可覆盖和[包清单](<../package.json>)的发布范围。组件来源与许可见[Client NOTICE](<../src/client/NOTICE.md>)。

prepack执行build，postpack清理生成目录。源码链接安装期间必须保留构建产物；安装独立包不会依赖源码工作树。通过DSH插件管理器安装，不手工编辑profile的依赖或patch文件。Host模块更新后完整重启DSH；Client的热更新能力不能替代Host重新加载。

## 测试策略

[测试入口](<../scripts/test.ts>)依次编译Host、检查Client类型、构建Client与vendor、严格检查测试类型、校验公开文档、执行所有顶层`.test.ts`、核对包边界。无论成功或失败都在finally里调用[清理函数](<../scripts/clean.ts>)，只清理经过路径验证的本仓库生成目录，不删除用户索引。

| 层次 | 关注点与代表测试 |
| --- | --- |
| 纯函数 | [分块](<../test/core-chunking.test.ts>)、[候选](<../test/core-candidates.test.ts>)、[cursor](<../test/core-cursors.test.ts>)、[设置模型](<../test/settings-client-model.test.ts>) |
| 数据层 | [真实LanceDB store](<../test/production-store.test.ts>)、[增量同步](<../test/production-sync.test.ts>)、[来源事件提取](<../test/session-text.test.ts>) |
| Host/worker | [桥接](<../test/bridge.test.ts>)、[生产Host（含后台补向量）](<../test/production-host.test.ts>)、[配置生命周期](<../test/settings-host.test.ts>)、[内容核验](<../test/acceptance-content.test.ts>) |
| 交互与产物 | [真实React/Base UI合成DOM交互](<../test/settings-interaction.test.ts>)、[Client产物](<../test/settings-artifact.test.ts>)、[依赖分发](<../test/packaging.test.ts>) |
| 多轮检索 | [合成挑战](<../test/challenge-flows.test.ts>)：完整遍历搜索cursor、逐引用核验、长文read续页及篡改拒绝 |
| worker协议 | [JSONL状态机](<../test/worker-protocol.test.ts>)：ready、configure前拒绝访问、单次配置与串行响应 |

默认回归使用合成会话和向量；Host 端到端测试启动真实 Node worker 并等待退出，HTTP 仅用本地 fixture。不读取真实会话或凭据，不调用外部 embedding 服务。数据构造约定见[合成fixture说明](<../test/fixtures/README.md>)。

### 按数据不变量组织断言

| 数据／状态 | 必须保持的关系 |
| --- | --- |
| 事件 → 消息／文本块 | 原seq、blockIndex、来源与附件集合不丢失；相同文字不是相同来源；缓存不得替代不可读或已变更的原事件 |
| session checkpoint／journal | 只有完整批次写入后才推进checkpoint；重放幂等；中断后恢复，不能查询半提交结果 |
| embedding空间／进度 | 本地同步本身不外发；只补已授权的缺失分块；失败保留已提交向量；不混用向量空间 |
| 搜索／读取快照 | cursor绑定调用者与查询条件；续页不重复embedding，结果顺序固定；篡改、到期与重启明确失败 |
| worker run／pending请求 | ready前不发请求；取消不自动重放；直接命令退出不等于受管范围退出；退出确认失败不能替代 |
| 配置基线／草稿／revision | 新目录不自动选入；嵌入范围受本地语料约束；授权改变重置确认；冲突或拒绝不得覆盖草稿 |

优先测试可观察行为和具体故障，不锁定函数排列、AST调用写法或英文提示句子。[包边界检查](<../scripts/check-package.ts>)统一负责模块格式、共享React、manifest和许可，测试文件不重复复制同一套检查。相同分支的等价标量用少量边界样本；不同的状态转换、Unicode边界、索引缺失与恢复阶段不能因为“看起来类似”而合并掉。

[Host测试辅助函数](<../test/helpers/host.ts>)只复用真实Node启动适配，不统一不同的源读取fixture，也不模拟真实DSH provider的受管范围。合成题库中的无证据、历史指令和未测指标场景仍可用于人工／模型评估；仅检查题面字符串不能证明拒答能力、prompt-injection防护或模型引用正确，因此不计入自动行为保证。

合成DOM不验证真实DSH布局、主题对照、屏幕阅读器或浏览器默认事件。修改UI后仍需在真实DSH设置页检查窄／宽布局、深／浅主题、焦点、键盘和拒写反馈。slot注册成功不等于视图已渲染；fixture生命周期测试也不能代替实际Loader/provider集成。

### 定向调试

```bash
pnpm run build
node --experimental-strip-types --test test/bridge.test.ts
node --experimental-strip-types --test test/settings-interaction.test.ts
pnpm run clean
```

上例只调用合成测试。`pnpm test`会自动管理构建与清理，适合作为提交前默认检查。不要并发运行会覆盖或清理同一个生成目录的build/test/pack命令。

可选的[外部文本诊断](<../evaluation/README.md>)与默认测试分离。相关脚本可能调用真实embedding服务，必须先确认数据许可、外发授权、费用与输出目录；安装依赖或运行`pnpm test`不会启动这些脚本。

## 修改约束

- 新增范围或外发能力必须有显式配置与校验，不能由目录变化、工具调用或UI打开自动授权。
- 修改提取规则时覆盖原始用户／模型来源、工具结果、relay、替换摘要、附件集合和fork继承身份；相同文字不等于同一来源。
- 修改数据模型、chunking版本、embedding空间或cursor格式时说明兼容策略，不覆盖不匹配的旧数据，也不自动清库。
- 保留取消后不自动重放请求、旧代退出确认后再替代、观测失败则拒绝重启的约束。`done`只代表直接命令结果，受管范围确认来自`waitForExit()`。
- UI只读会话元数据；保存使用开始编辑时的revision和完整操作列表。失败保留草稿，重定基线必须重新审查权限。
- 不记录密钥、原始stderr、完整后端异常或用户环境文件。诊断计时按[计时模块](<../src/shared/timing.ts>)的允许字段输出，不能把调试日志当作可公开的数据集。

## 文档维护

四份主文档分别是[README](<../README.md>)、[架构](<architecture.md>)、本指南和[接口参考](<api.md>)。按当前行为维护，不累积机器专属的安装交接、逐轮试验或聊天决策。`pnpm run check:docs`检查公开文档链接、主文档集合与明显的私有标识；第三方许可必须保留，不能因精简文档而删除版权说明。

Git忽略的环境文件、索引、原始评估输出和本地记录不属于公开文档。忽略规则不能擦除Git历史；首次公开仓库前应独立检查已有提交及文件的数据许可，尤其不要把来源不明的外部语料当成项目自有合成对话。
