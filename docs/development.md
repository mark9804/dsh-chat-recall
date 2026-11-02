# TypeScript 源码阅读与开发

v0.2.1 是阶段性代码整理：正式实现从 JavaScript 迁到 TypeScript，不改变索引格式、工具参数、分块策略、候选阈值或已有数据。

## 从哪里开始看

建议按下面的顺序阅读，而不是先钻进数据库代码：

1. [model.ts](<../src/shared/model.ts>)：索引行、原文块、搜索结果与 embedding 接口。
2. [protocol.ts](<../src/shared/protocol.ts>)：Host 与 worker 的请求／返回类型映射。方法名与参数、结果在编译期关联。
3. [plugin.ts](<../src/host/plugin.ts>)：插件配置、四个模型工具、范围限制、分页封装和原事件核验。
4. [sync.ts](<../src/host/sync.ts>)：读取日志尾部、校验 anchor、生成增量批次；不直接操作数据库。
5. [store.ts](<../src/storage/store.ts>)：LanceDB schema、journal 恢复、向量进度、检索与原文读取。

算法可独立读：

| 源码 | 职责 |
|---|---|
| [chunking.ts](<../src/core/chunking.ts>) | 段落／句尾分块，保留原文 UTF-16 偏移 |
| [candidates.ts](<../src/core/candidates.ts>) | 根据分数差选择 1 或 3–5 条正文，输出前三名比较 |
| [cursors.ts](<../src/core/cursors.ts>) | 固定搜索快照、签名游标、TTL 与容量限制 |
| [client.ts](<../src/embedding/client.ts>) | OpenAI-compatible embedding 协议、批处理、超时、取消与响应校验 |
| [session-text.ts](<../src/shared/session-text.ts>) | 从 DSH 事件提取原始可见消息，排除注入与替换摘要 |

运行边界：

| 源码 | 职责 |
|---|---|
| [bridge.ts](<../src/host/bridge.ts>) | 受管理独立 Node 子进程、JSONL 请求、取消和退出确认 |
| [contracts.ts](<../src/host/contracts.ts>) | 实际使用的 DSH 公共接口最小结构类型 |
| [types.ts](<../src/host/types.ts>) | 工具参数、Host 游标和配置类型 |
| [main.ts](<../src/worker/main.ts>) | 子进程入口，串行分发操作 |
| [settings.ts](<../src/client/settings.ts>) | DSH原生设置页、草稿和授权确认 |
| [config.ts](<../src/host/config.ts>) | 可编辑配置schema、运行时快照与校验 |

## 构建与测试

```bash
pnpm install --ignore-scripts
pnpm run typecheck
pnpm test                 # build → TS测试类型检查 → 回归 → clean
pnpm run format:check
pnpm run build           # 安装前显式构建
pnpm run clean           # 删除dist，不触碰其他目录
```

运行开发工具需要支持type stripping的Node >=22.6，推荐24 LTS；无需tsx/ts-node。测试Node必须能加载LanceDB原生模块，可用 `RECALL_TEST_NODE` 覆盖默认的 `process.execPath`。从源码链接安装前先build，运行期间不能clean；安装打包文件则不会依赖仓库里的dist。

[tsconfig.json](<../tsconfig.json>) 使用：

- `strict: true`，包含 `noImplicitAny` 与严格空值检查；
- `NodeNext` ESM、目标 `ES2022`，输出目录 `dist`；
- `noEmitOnError: true`，类型错误不能生成新产物；
- 声明文件、声明映射与 source map；
- `skipLibCheck: true` 只跳过依赖声明内部检查，不跳过本项目源码。

编译结果不是第二套手写实现。DSH的包导出指向编译后的Host JS；独立Node执行编译后的worker JS；Client通过DSH ModuleLoader加载设置页工厂。运行时不需要ts-node、tsx或TypeScript loader。

[build-client.ts](<../scripts/build-client.ts>)只去除type-only imports导致的空ESM标记，保留source map行位置；不引入新bundler。Client单文件工厂仅require宿主React，不复制React、不import宿主UI包。配置读取与保存使用宿主共享configForms，样式使用已核对的theme tokens，中英文文本走locale。

[package.json](<../package.json>) 的test通过 [test.ts](<../scripts/test.ts>) 先构建、再按 [tsconfig.test.json](<../tsconfig.test.json>) 严格检查所有TS测试、执行回归与产物边界检查；无论成功或失败都在finally中调用 [clean.ts](<../scripts/clean.ts>) 删除dist。只删除验证过的本仓库生成目录，不删除任何索引数据。

prepack先构建，postpack清理；`pnpm pack --pack-destination <仓库外目录>` 可把安装包存到源码树之外。开发依赖固定TypeScript、Node类型与Prettier版本，不执行安装脚本。

## 依赖打包

LanceDB 0.41.0 的完整npm包带有可选OpenAI和Transformers依赖，源码workspace的ignoredOptionalDependencies不会传播到消费插件的profile。v0.3.1将完整包改为开发依赖；[build-vendor.ts](<../scripts/build-vendor.ts>)在构建时把上游dist原样复制到产物内，保留原生加载器和所有许可告知，只生成精简package.json与来源说明。

实际运行依赖是Arrow、OpenTelemetry API、reflect-metadata和按平台安装的LanceDB原生包。插件没有使用上游自动embedding集成，不安装OpenAI／Transformers SDK，也不授权onnxruntime-node、protobufjs、sharp的安装脚本。字节一致性及依赖声明在 [打包测试](<../test/packaging.test.ts>) 中核对。

上游代码不是手写的第二套实现，随dist一起清理。Apache许可文本来自 [Apache官方](https://www.apache.org/licenses/LICENSE-2.0.txt)；升级LanceDB必须重新核对依赖与许可证。完整包保留跨平台原生可选包；本轮只实测macOS arm64。

## 类型边界的约定

- 业务数据在 [model.ts](<../src/shared/model.ts>) 和 [store.ts](<../src/storage/store.ts>) 中明确定义，LanceDB 使用其官方 `Table`／`Query` 等类型。
- [contracts.ts](<../src/host/contracts.ts>) 只是当前 DSH Inspect 核对过的最小结构视图，**不是官方完整 SDK，也不伪装成官方模块声明**。升级 DSH 时应重新核对。
- `import type` 不进入运行时，因此 Host 不会因引用存储接口而加载 LanceDB 原生库。
- JSONL、HTTP JSON、Arrow 行和持久化 JSON 仍是运行时边界。保留原有检查，并在已知 schema 的转换位置做窄断言；TypeScript 不能代替运行时验证。
- 正式源码没有 `any`、`@ts-ignore` 或 `@ts-nocheck`。没有用关闭 strict 的方式通过迁移。

## 测试覆盖与清理范围

正式测试现为 `.test.ts`，完整保留核心算法、HTTP协议、桥接生命周期、事件提取、生产存储、同步和Host流程的断言；仍导入临时dist来验证实际运行产物。故意无效的输入使用局部类型断言，不关闭strict检查。

已删除旧JS实现、兼容转发、实验worker/Host、一次性迁移脚本、本地测试包装包和旧打包文件。只针对废弃实验实现的5组测试不再保留；测试数量降低并不代表删除正式功能断言。早期验证文档保留为历史记录，链接到已删代码的部分已标记退役。

第三方依赖目录不是本项目源码，不删除依赖内部的JS。Git忽略的历史证据、真实聊天索引和凭据也不属于构建产物，不在清理范围。

## 源码-only 清理验证

正式TS测试 **175/175通过**，strict检查与实际编译产物边界检查通过；测试结束dist已自动清理。原迁移阶段197项中，22项旧实验专用用例随退役实现删除，正式功能用例全部保留。详见 [清理记录](<cleanup.md>)。

## TypeScript 迁移阶段验证（清理前）

- `pnpm run typecheck`：通过，strict 模式。
- `pnpm run format:check`：通过。
- `pnpm test`：**197/197 通过**，其中195项沿用原回归，新增2项保持worker的裸JSONL configure缺省参数兼容性。
- DSH签名Node作为父进程执行正式Host集成测试：**4/4通过**；LanceDB仍只在独立Node子进程加载。
- 独立只读审查发现的configure缺省兼容差异已修复；Host实际header类型与历史提取fixture类型已分开，不再用origin断言掩盖类型矛盾。
- v0.2.1打包检查包含源码、编译JS、声明及映射；不包含.env、实验数据库、旧实验入口或本机配置。

上述197项是迁移阶段结果，不是清理后的测试数。后续按用户要求进行了源码-only清理：四个指向仓库的本地链接包已通过plugin_manager卸载，原索引和配置快照保留；没有迁移数据库、调用远程embedding或发布npm。重新使用时须构建并安装正式包，恢复需要的配置范围。
