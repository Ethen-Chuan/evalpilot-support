# Agent Trace 接入与问题定位

## 1. 当前内置追踪

无需额外设置：客服问答、公开数据评测、中文业务回归都会自动记录。点击答复 / 实验中的「查看执行 Trace」，或左侧「Agent Trace」。

记录内容包括：

| 业务步骤 | 可分析的证据 |
| --- | --- |
| 输入门禁 | 允许 / 拒绝、检查结果；不保留未通过检查的输入正文 |
| 上下文读取 | 会话编号、上一轮知识来源与 Trace 编号 |
| 知识快照 | 知识条数、版本映射、SHA-256 |
| 语言与意图路由 | 选择的分支及明确规则依据，而非模型隐藏思维链 |
| 英文分类 | 模型类型、数据指纹、缓存 / 训练、候选类别与分类分差 |
| 知识检索 | 候选条目、命中词、分值、选中内容 / 版本 |
| 答复与升级 | 工具实际返回、转人工建议；是否执行真实转接单独标示 |
| 异常 | 类型、脱敏消息、代码文件 / 行号 / 函数，不保存局部变量 |
| 评测 | 拆分检查、训练或缓存、验证校准、测试批次、统计与结果保存 |

耗时包含子步骤，不能将所有 span 耗时相加当作总耗时。当前写入 SQLite 的开销也包含在实际运行耗时内。不同请求的执行上下文隔离；自动跨线程或跨进程传播尚未实现。

## 2. 接入自己的 Python Agent

在项目目录运行；或者把项目根目录放入 Python 模块搜索路径。此 SDK 随项目交付，尚未发布为独立安装包。

```python
from sdk import AgentTrace

question = "我想查询退货政策"
with AgentTrace(
    "电商客服执行",
    endpoint="http://127.0.0.1:4287",
    inputs={"query": question},
    attributes={"agentVersion": "customer-support-v1"},
) as trace:
    with trace.step("检索退货政策", "retrieval", {"query": question}) as step:
        documents = policy_store.search(question)
        step.output(documents)

    with trace.step("调用客服模型", "model", attributes={"model": model_name}) as step:
        answer = model_client.answer(question, documents)
        step.output({"answer": answer})

    trace.output({"answer": answer})
```

`policy_store`、`model_client` 和 `model_name` 由你的 Agent 提供，示例不包含模型客户端或其调用权限。只包装真实调用；没有发生的步骤不要补写，也不要把计划动作当作已经完成。

直接可运行的本地函数示例：

```sh
python -m sdk.example_agent
```

这会真实执行两个本地函数步骤，但不是 LLM / 订单系统集成；页面会标记为「外部 Agent 自报」。SDK 仅允许向 localhost / 127.0.0.1 HTTP 端点发送脱敏记录，不会自行将业务数据上传云平台。包裹的 Agent 自己是否调用外部系统由其实现决定，SDK 并不限制其网络行为。

嵌套 `trace.step(...)` 建立父子关系。可调用 `step.event("retry", {"attempt": 2})` 记录实际事件，调用 `step.attributes(...)` 添加执行属性。重试循环每次必须单独包装；不会凭空推断重试次数。

异常会保留原有抛出行为，并被记录在出错步骤及外层执行中。若执行成功但上报失败，SDK 显式抛出上报错误，不静默丢数据；若业务本身已失败，则保留业务异常并在 `trace.submission_error` 记录上报失败类型。可在执行结束后显式 `trace.submit()` 重试；相同 Trace 编号禁止覆盖，网络响应丢失时应先查询是否已经保存。

## 3. 接口与字段

- `GET /api/support/traces`：分页列表，参数 `q`、`status`、`source`、`minMs`、`page`。
- `GET /api/support/traces/{traceId}`：详情。
- `GET /api/support/traces/{traceId}/export.json`：脱敏 JSON 下载。
- `POST /api/support/traces/ingest`：其他语言 Agent 的结束态记录导入。

协议 `schemaVersion=1.0` 是本项目自定义格式，不是 OTLP。必须提供：

| 字段 | 约束 |
| --- | --- |
| `id` | 唯一 32 位小写十六进制字符串 |
| `name` | 1–180 字符 |
| `startedAt` | 带时区的 ISO-8601 时间 |
| `durationMs` | 有限非负数，真实测量的毫秒耗时 |
| `status` | `ok` / `error` / `blocked` / `cancelled` |
| `spans` | 1–250 个 span，仅一个根节点 |
| span 的 `id` / `parentId` | 16 位小写十六进制；根的 parentId 为 null |
| span 的 `name` / `kind` / `status` | 明确步骤名、类型与实际状态 |
| span 的 `startMs` / `durationMs` | 相对 Trace 起点的毫秒偏移与耗时；子步骤须在父步骤内 |

步骤类型：`agent`、`guardrail`、`memory`、`retrieval`、`model`、`tool`、`routing`、`evaluation`、`storage`、`internal`。

可选内容：`input`、`output`、对象型 `attributes`、数组型 `events` 和异常对象 `error`。事件含 `name`、相对整条 Trace 起点的 `offsetMs` 和对象型 `attributes`。异常含 `type`、`message`，以及可选 `frames` 数组，每帧含 `file`、正整数 `line`、`function`。

每次 HTTP 请求不超过 256,000 字节。内容限制为 8 层嵌套、对象 / 列表前 100 项、单字符串最多 3,500 字符；截断处有标记。模型大输出应单独保存获授权的制品，仅在 Trace 写摘要与制品指纹。

服务端校验树结构、父子计时、事件与异常格式；先掩码再通过本地扫描门禁，之后才入库。拒绝覆盖已存在编号。客户端提供的执行结果仍是自报，不能作为不可篡改审计凭据。

## 4. 怎样溯源

1. 先看「执行异常 / 中断」或「质量待关注」，不要混淆技术故障和业务失败。
2. 异常轨迹自动选择出错的子步骤；「异常定位」展示代码位置。
3. 质量问题检查检索输出、知识版本、意图分差与最终答复，排查知识缺失、错路由或阈值拒绝。
4. 对照会话 / 实验编号和知识指纹，确认当时使用的版本；不能只看当前知识库内容。
5. 关联反馈与排查任务。任务不会因为移动状态就被判定已修复；会话问题还需要人工标注与复核。

## 5. 安全与未实现能力

默认掩码凭证字段、常见凭证字符串、邮箱、长数字和本机用户名路径；没有能力可靠识别所有人名、地址、客户名称和语义敏感内容。分享导出物前仍需人工复核。扫描器缺失时拒绝新的自由文本持久化，不承诺绝对安全。

当前没有自动采集任意 Agent、浏览器操作录屏、跨服务 `traceparent` 传播、OTLP、鉴权、权限隔离、审计签名、自动保留期或生产规模查询优化。仅保存在本机，适合验证，不可原样暴露到公网。Trace 记录可观察的执行证据，不记录模型隐藏推理过程。
