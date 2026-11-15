# 可选检索诊断输入

本目录的[查询清单](<queries.json>)用于已知目标检索诊断，不是默认回归、真实聊天数据集或可用于宣称通用准确率的基准。默认测试只需要[合成对话fixture](<../test/fixtures/README.md>)。

## 外部文本需要自行提供

查询清单引用两个文本输入：

| 逻辑文件名 | 格式 |
| --- | --- |
| `captions_coco10k.txt` | 每行一个英文图像描述，预期10000行 |
| `mixkit_prompts_vid.txt` | 每行一个英文视频描述，预期6484行 |

相关[诊断脚本](<../scripts/evaluate-qwen.ts>)从`test/test-chunks`读取这些名字。外部描述不属于项目自有合成对话；本仓库不声明其再分发权，不将本地数据文件纳入公开文件或安装包。使用者需取得适当许可，并确认文件版本、行号与查询中的`targetHash`一致。未提供输入时不要运行这些可选脚本；它们不影响`pnpm test`。

## 查询类型

[queries.json](<queries.json>)定义24个目标，每个有一条英文意译和一条中文查询，共48条positive；另有4条预期域外negative。它们是按位置分层后人工选取的特定目标，不是随机样本，也没有穷尽所有相关项。

```ts
type DiagnosticQuery = {
  id: string;
  source: 'captions_coco10k.txt' | 'mixkit_prompts_vid.txt' | null;
  line: number | null;          // 1-based原始输入行，不是chunk序号
  language: 'en' | 'zh';
  kind: 'positive' | 'negative';
  query: string;
  targetHash?: string;          // SHA-256：UTF-8目标行，不含换行，不trim
  notes?: string;
};
```

查询文本、标签、来源行号和hash是输入，不包含运行成绩。只把`query`发送给embedding，不把标签或hash拼入正文。中文／英文是同一个目标的配对，不是48个独立目标。

## 运行边界

- [输入盘点脚本](<../scripts/evaluate-qwen.ts>)的`inventory`阶段只分析本地文本；`probe`阶段会请求真实embedding。
- [运行评估脚本](<../scripts/evaluate-runtime.ts>)、[词法诊断](<../scripts/evaluate-lexical.ts>)和[物化对比](<../scripts/evaluate-materialization.ts>)是手动工具，不由测试入口触发；部分路径需要已有库／查询向量，部分会调用真实模型。[离线profile脚本](<../scripts/profile-local-latency.ts>)要求显式传入基线包目录，不使用机器专属默认路径。
- 执行前先阅读目标脚本、确认数据许可与外发授权、模型／维度、费用和输出目录。环境变量来自运行者自己配置，不应提交环境文件。
- 输出写入Git忽略的`.benchmark`。结果、向量、原文摘录和HTTP审计不能因“不含密钥”就自动公开；先做数据与隐私审查。

## 如何解读

1. 按`source + line`计算已知目标Hit@k；多个chunk先映射回同一来源行，不把它称为全语料语义Recall@k。
2. 同文替代与近义相关结果应单列，不改写原标签。没有穷尽qrels时不据未标注项计算可信precision／nDCG。
3. ANN与flat应比较同一份向量的邻居，邻居保留率不是embedding语义准确率。
4. negative只检查候选与分数。没有独立校准的拒答策略时，不报告自动拒答成功率。
5. 分别记录模型、空间身份、分块参数、来源行／chunk／向量数、索引参数、硬件与冷／热条件。初始化、query embedding和本地检索耗时不能混成单一“查询延迟”。

文档不保留机器专属运行结果、安装记录或实际聊天问题。开发与测试入口见[开发指南](<../docs/development.md>)。
