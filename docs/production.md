# dsh-chat-recall v0.3 使用与边界

这是可安装的Host＋Client插件，设置页集成在DSH内，不是独立网页或MCP服务器。需要可加载第三方原生模块的独立Node >=22.6（推荐24 LTS）；macOS DSH内置签名Node不能代替它。Host只负责DSH接入，LanceDB运行在受管理子进程中。

## 安装与配置

用DSH插件管理器安装本包。默认 `sessionIds: []`、`embeddingSessionIds: []`，不会读历史或发请求。

源码仓库现为TS-only，不常驻构建产物。源码链接安装前先执行 `pnpm run build`，链接运行期间不能clean；若希望仓库始终干净，执行 `pnpm pack --pack-destination <仓库外目录>` 后安装生成的包。pack会先构建再清理仓库产物。

安装后在 **DSH 设置 → 对话回溯** 配置，不必编辑YAML。编辑先暂存在页面，保存时使用DSH原生revision校验；新配置关闭旧实例后生效，旧分页游标随之失效。扩大索引／外发范围需要明确确认；打开页面本身不触发索引或embedding。详见 [设置页说明](<settings.md>)。

配置字段：

| 字段 | 含义 |
|---|---|
| nodePath | 独立Node绝对路径，或已在PATH中的node |
| dataPath | 本地派生索引绝对目录；同一个目录只挂一个实例 |
| sessionIds | 要本地索引的会话ID列表；`["all"]`涵盖跨工作区主对话，包含归档与用户分叉，不含delegationDepth>0子agent |
| embeddingSessionIds | 明确允许将文本发给embedding的会话；`["all"]`仅限上述文本语料 |
| envFile | 独立Node读取的凭据文件绝对路径；不在聊天中粘贴密钥 |
| callerSessionIds | 可选工具调用者白名单；空表示profile中的agent可调用 |
| autoSync | 默认true，后台回填及处理新增事件；false时工具调用按需同步 |
| dominantMin | 单结果展示的首位cosine下限，默认0.50 |
| dominantGap | 单结果展示首位减次位的最小差，默认0.15 |

凭据环境变量为OPENAI_API_KEY、OPENAI_BASE_URL、OPENAI_EMBEDDING_MODEL、可选OPENAI_EMBEDDING_DIMENSIONS。默认模型text-embedding-3-small。支持OpenAI-compatible `/embeddings`；不支持OAuth。改模型/endpoint/维度不得混用旧库，须用独立dataPath重建；exact/fuzzy仍可使用原文本。

## 工具

- `chat_recall_search`：query + mode（exact/fuzzy/semantic）；scope默认current，可选会话ID或all。支持role和毫秒时间范围。续页传相同条件和nextCursor，不重新embedding。
- `chat_recall_read`：用ref、blockIndex读取原话及邻居，长文用nextCursor续读；Host逐页回读DSH核验。
- `chat_recall_sessions`：在配置语料内发现会话，支持标题查询和offset页。
- `chat_recall_status`：查看索引、队列与错误；action=sync补文本，action=embed显式生成已允许范围内缺失向量。

语义初次单会话查询自动补该会话向量，会产生费用；跨多个会话的查询只用已有向量，先通过status/embed分范围准备。精确、关键词、原文回读和cursor续页不发送embedding请求。不要把后台同步完成误认为embedding已完成。

## 自适应候选

没有额外cross-encoder或LLM重排：语义模式先按范围过滤，ANN时取候选，然后计算精确余弦、按同来源去重重排。

- 至少3个候选且top1>=0.50、top1-top2>=0.15时，只显示第一条正文，附前3名ref与分数。
- 否则显示3条，第四/第五名与第三名相差<=0.08时一起显示，最多5条；不足3条按实际数。
- 显式limit（1–20）覆盖自动数量。
- 下一页从实际已展示条数之后开始；附上的第2/3名分数不算已消费正文。
- 所有相似度都是候选分数，**不是正确率、相关性裁决或自动拒答**。低分也不能证明历史没有答案。
- fuzzy按完整查询词覆盖率，再按BM25排序；它与cosine没有可比的统一分数。

## 保真分块与原文

段落优先、句尾/换行次之；目标600 codepoint，最大720。无边界长文本才硬切；合并短尾，不拆Unicode surrogate。原文不修改、偏移为UTF16、同一block连续完整覆盖。精确搜索使用完整block，跨向量分块边界也可找回。

来源的event seq、blockIndex、角色、原始messageId与哈希都保留。真正同来源的继承内容可去重；只是字面重复的独立发言不会合并。reasoning、工具结果、注入内容与压缩替换摘要不作为用户/助手原话。图片/PDF只保留附件引用，不OCR、不上传附件。

## 增量同步与恢复

每会话cursor+末尾事件哈希。新增尾部按256事件一批读取/提取/传输，消息和文本写入完成后才推进checkpoint。journal使中断批次重放幂等；未完成恢复前不提供半写索引。embedding有独立缺失块进度，每批成功向量先入库再继续下一请求。

live源使用公开observeSession快照后仅提取尾部；冷源使用sessionPersistence只读handle范围读取。**公开API内部可能物化完整事件引用数组或解码完整压缩文件**，不声称底层存储已实现物理字节范围读取。通知只标dirty，不在session/event回调中重扫全日志。重启与工具调用会补漏。

源事件被改写或checkpoint anchor不匹配时报SOURCE_CHANGED，不默默更新原话。DSH日志不会被插件修改。

## 分页与容量

会话列表第一页固定配置内的完整ID集合，未索引项明确标pending，不因只补20个索引就漏掉其余会话；续页不重新排序。标题筛选若仍有未索引项会报告不完整。全局搜索的scope成员也固定在初次查询，不因新会话出现而使旧cursor失效。

每次查询固化最多1000候选的快照。新消息不改变已有分页顺序；cursor绑定调用者和完整条件、30分钟过期，重启后明确过期。每进程最多64个有效快照，超出报告容量错误，不默默丢弃仍可使用的cursor。

局部<=10000向量用flat精确余弦；更大用IVF_FLAT候选后精确计算，结果披露非穷举与截断。1000候选上限不是全库枚举保证。分页覆盖快照内全部候选，不等于穷尽全库。

搜索快照与恢复journal含聊天文字，保存在dataPath本地；不会自动删除历史实验或用户文件，磁盘会增长。敏感环境应保护该目录。本版不提供无确认自动清理。

## 尚不声称完成

- 没有经过独立验证集校准的自动拒答或置信度。
- 没有证明百万真实高维向量的召回/延迟；合成大规模分支测试不能代替真实质量基准。
- 没有独立搜索页面；配置、工具执行和结果在DSH现有界面中使用。
- 不自动迁移旧实验数据库，不自动扩大外发范围，不自动发布npm。
