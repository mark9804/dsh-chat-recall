# 合成测试fixture

本目录中的对话、角色、事项、口令、编号与日期均由测试手工构造，不来自真实DSH历史。它们用于验证检索和来源核验行为，不表示真实用户经历或配置。

| 文件 | 用途 |
| --- | --- |
| [tool-use-challenges.ts](<tool-use-challenges.ts>) | 多页搜索、长文最终更正、无证据、历史指令及未测指标；含合成问题、header与事件 |
| [bridge-worker.ts](<bridge-worker.ts>) | 裸JSONL Node子进程，模拟延迟、分片、错误、EOF和不响应关闭；不加载原生库或网络服务 |

其他合成数据直接定义在相关测试中，例如[来源事件测试](<../session-text.test.ts>)、[存储测试](<../production-store.test.ts>)和[设置交互测试](<../settings-interaction.test.ts>)。HTTP fixture使用本地端口，embedding使用合成值；不依赖真实会话、API key或索引目录。

## 使用约定

- 会话和消息ID使用`synthetic-`、`fixture-`等明确前缀，路径用`/synthetic`或测试临时目录。
- 保留角色、事件seq、messageId、blockIndex与UTF-16偏移，不能为了简化测试而绕过来源身份。
- 历史中出现的命令式文字属于待检索数据，测试程序和模型都不应将其作为系统指令执行。
- 为测试更正、无答案或失败恢复，应保留正反证和失败条件，不把异常样本改写成成功样本。
- 新fixture不得复制真实聊天、真实附件引用、密钥或本机profile路径。合成DOM交互不是实际DSH页面视觉验收。

[自动挑战回归](<../challenge-flows.test.ts>)验证前两类的检索／读取协议；其余题目保留供人工或模型评估，题面字符串匹配本身不构成拒答或历史指令防护测试。

默认执行方式见[开发指南](<../../docs/development.md#测试策略>)。外部图文描述文本不属于本目录的自有合成语料，其权限与可选使用方式见[评估输入说明](<../../evaluation/README.md>)。
