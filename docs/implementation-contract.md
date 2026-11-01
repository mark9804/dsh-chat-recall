# 正式插件实现契约（v0.2）

本轮落地范围：段落分块、原文回读/搜索续页、增量同步、自适应候选展示。独立 Node + LanceDB；保留实验代码但发布入口不依赖实验模块。

## 数据与状态

- DSH append-only 日志是真源；本地索引可重建。
- `sessions`：sessionId、标题、cwd、origin、createdAt、inheritedEventCount、cursor（最后完整应用事件seq）、anchorHash（该事件哈希）、updatedAt。
- `messages`：id=`sessionId:seq`、sessionId、eventSeq、role、time、sourceMessageId、contentJson（仅可见块，保留原blockIndex）。
- `blocks`：id=`sessionId:seq:blockIndex`、messageId、sessionId、eventSeq、blockIndex、role、time、origin、text、textHash、dedupKey（来源messageId+角色+blockIndex+textHash；无来源ID时使用当前位置）。
- `chunks`由完整block派生，保留UTF16 `[start,end)`，不跨消息、不改原文；向量键包括spaceId、blockId、chunkingVersion、start/end、textHash。
- 单worker串行处理写操作；批次可重放，checkpoint最后提交；崩溃后先重放未完成批次再服务查询。不会更新DSH日志。
- embedding只处理显式配置允许的会话；文本同步与向量进度分开，不因向量失败阻断exact/fuzzy。

## 分块

目标600 codepoint，优先空行段落，其次句末/换行，过长无边界时硬切；短尾合并/重平衡，UTF16偏移连续覆盖原文。固定策略版本写入vector key，不提供一堆模型参数。

## 检索与候选

- exact：完整文本子串验证，不能只查chunk；命中按时间/来源稳定排序。
- fuzzy：中文词项/n-gram候选，按完整查询词覆盖率重排，原始BM25作同覆盖下排序；返回coverage与BM25，不伪装成语义概率。
- semantic：余弦相似度；先硬范围过滤、候选内精确重算并按来源去重。暂无额外LLM或cross-encoder，明确标注rerank方式。
- 自适应展示只用于semantic：初版启发式 `top1>=0.5 && gap12>=0.15` 且至少3个候选时可只返1条正文；否则返3–5条（少于3条时如实返回）；附top3分数、分差、阈值和candidates-only提示。不是正确率或自动拒答，阈值可配置。
- 明确无结果和候选不是同一概念；低分不直接认定无答案。
- 所有被缩减的正文都可通过nextCursor继续读取；top3摘要不算正文已消费。

## 分页

搜索初次结果固化为本地有界快照，后续cursor不重新embedding、不受新增消息改变已有顺序；cursor绑定查询/范围/调用者，过期明确报错，不静默换快照。候选上限明确截断，不宣称全库枚举完成。
原文按稳定ref与UTF16区间读取，返回nextCursor；每页Host回读原事件核验。上下文消息与纯附件保留。

## 同步

配置 `sessionIds` 或显式 `all` 选择文本语料，默认空集合；排除subagent但不排除普通fork或归档。首次回填原日志；后续只提取/传输/索引cursor之后的尾部，核对anchor。live通过session/event仅标dirty并批处理；重启/漏通知时工具调用前补同步。冷会话公开query接口可能重新装载日志，不能宣称底层字节范围读取已经优化。

## 工具

`chat_recall_search`、`chat_recall_read`、`chat_recall_sessions`；另一个小型 `chat_recall_status` 用于覆盖/队列/错误诊断。工具参数不接受任意文件路径或密钥，不自动扩大配置范围。默认省略scope只查当前会话，`all`只查配置内的主对话。

## 部署边界

Host不import原生库；独立Node路径是显式前置条件。profile配置不打包本机密钥。此次安装验证限制已授权源会话，不自动全局外发；正式包与本地验证wrapper分离，不发布npm。
