# EvalPilot · 模型评测平台

本机运行的模型评测平台，当前以售后客服场景为基础：完整对话阅读、Agent Trace、图文模型对比、转人工拦截指标、人工复核与同批重跑。

「项目集」是平台级入口，每张卡片对应一个实际导入的业务项目，售后客服不是平台名称。现有行为基线和转人工拦截指标面向售后场景；其他业务需另行准备数据、规则与评测标准，不能直接套用售后结论。

**这是不含客户数据的源码发布版。** 首次启动没有真实售后项目、已训练版本或外部模型成绩；不包含原工作区的数据库、客户图片、训练模型、密钥和历史分数。自建校验图文需在页面主动创建，不冒充客户数据。

## 能做什么

- 文本页直接选择模型A/B、添加连接并弹窗输入Key；新建同批对比与查看已有结果分开。
- 使用同一图片、问题和政策，对比不同厂商，或同厂商两个不同模型版本。
- 结果大盘提供质检复核环图、动态模型曲线、意图树与DSAT证据归因；实验支持搜索、收藏、归档与恢复。
- 支持 OpenAI / Anthropic / DeepSeek 官方接口，密钥在弹窗输入，只存本机服务内存；视觉模型必须先通过真实图像读取测试。
- 记录图片指纹、模型调用、路由建议、裁判证据和人工修订，支持 Trace 追溯。
- 展示有效拦截率、错误拦截、必要转人工召回、视觉正确率、评审覆盖、失败和未执行数量。
- 按数量或手动选择案例重跑，原批次不覆盖；比较只接受相同案例与评测条件。
- 导入获授权、已脱敏的完整文本对话后，可训练本地行为分类器并查看版本差异；不是大语言模型微调。

## 首次运行

依赖：Node.js 22.12+；Python 3.9–3.12。图文 OCR 使用 macOS Vision，需要 macOS 与 Xcode Command Line Tools。其他系统可浏览页面和使用兼容功能，但图片扫描不可用时会阻止导入和调用，不绕过隐私门禁。

```sh
npm ci
npm run build
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm start
```

打开 `http://127.0.0.1:4287/#compare?mode=vision`。仅监听本机回环地址，不要直接开放到公网。

### 必需的隐私扫描器

自由文本保存、图片导入和外部调用需要本机兼容 DLP 扫描器。默认检查本机 Codex DLP 安装；也可设置 `EVAL_DLP_PATH` 指向已审核的扫描程序。扫描器及其私有策略不包含在仓库里。

```sh
EVAL_DLP_PATH=/absolute/path/to/dlp npm start
```

接口要求见 [安全说明](SECURITY.md)。没有扫描器时，页面可打开，但受保护操作会拒绝执行。不能配置一个无条件返回通过的脚本来跳过检查。

## 五步体验图文评测

1. 在「模型对比」切换到「图文与转人工拦截」。
2. 添加获授权的脱敏真实图片，或主动准备24张已审核公开板卡照片及改编题目；也可选择4个自建校验案例。三种来源不混跑，公开素材保留署名与许可。
3. 点击「添加模型 / 输入 Key」，创建两个不同模型 ID 的连接。分别授权并通过「测试图像读取」。此步骤和之后的模型运行可能收费。
4. 选择同一个裁判，或保持人工复核；选案例数量，核对发送范围并授权运行。
5. 看拦截大盘与逐例回复，打开 Trace，人工复核，再按数量重跑或比较。

密钥只在密码框输入，切勿写入代码、提交、截图、Issue 或聊天。服务重启后需重新连接。

## 指标不能混用

有效拦截率（离线评审）要求：标准路由可自助解决、候选直接答复，并且看图、政策合规、解决需求三项全部通过。分母是本批全部选定案例；失败和待评不算成功。

没有转人工不等于问题解决。明确人工诉求、安全风险和权限不足应当升级；错误拦截必须单独看。线上真实拦截率尚未测量，需要完整会话、用户解决确认、实际转接、重复联系和观察窗口。这里不是闭环多轮用户模拟，不执行真实退款、派单或人工转接，暂不评测音频和视频。

## 文档

- [操作说明](docs/售后客服评测平台_操作说明.md)
- [图文评测协议与接口](docs/MULTIMODAL_EVALUATION.md)
- [文本语料脱敏与导入](docs/CORPUS_IMPORT.md)
- [本地行为训练与比较](docs/AGENT_LAB.md)
- [Agent Trace SDK](docs/TRACE_INTEGRATION.md)
- [完整对话与知识沉淀](docs/CONVERSATION_KNOWLEDGE.md)
- [体验大盘与RCA接口](docs/EXPERIENCE_INTEGRATION.md)
- [模型选择与同批对比验证](docs/MODEL_SELECTION_20261015_VERIFICATION.md)
- [公开图片署名](backend/public_vision/ATTRIBUTION.md)
- [源码发布检查](docs/RELEASE_CHECKS.md)

## 检查

```sh
npm run build
node --test tests/lab-navigation.test.ts tests/comparison-selection.test.ts
.venv/bin/python -m unittest discover -s tests -p test_multimodal.py -v
.venv/bin/python -m unittest discover -s tests -v
```

部分测试依赖本机 DLP 模块。全量测试中保留一个已知的固定日期排序测试问题，详见发布检查；不宣称所有历史测试都已通过。外部供应商在线验收需要使用者提供密钥并明确授权，协议替身测试不能当成真实模型成绩。

## 运行与发布边界

React / TypeScript / Vite 前端，Python HTTP 服务，SQLite 本地存储。`data/` 在运行时创建并被 Git 忽略；`EVAL_DATA_DIR` 和 `EVAL_MODEL_DIR` 可指定其他本机目录。`scripts/open_workspace.py` 用于 macOS 后台启动，未实现开机自启。

没有多用户鉴权、租户隔离、数据库加密、生产审计签名或生产安全加固。仓库私有也不意味着允许上传客户数据。自动规则未发现明确敏感项不保证绝对安全。
