# 售后图文与转人工评测协议

更新：2026-10-13。协议：`aftersales-vision-containment-v1`。

## 范围与公平性

单轮文字与单张 PNG/JPEG，不是闭环用户模拟或生产转接。没有模型密钥时不制造分数。自建校验为 calibration，用户声明真实数据为 real，不能混跑。旧文本记录保留。

冻结问题、当前上下文、图片 SHA-256、政策、视觉事实、参考答复、标准路由与确认时间。候选只收到 question、policy 和同一 PNG，不收到参考答案、路由标注与后续信息。裁判收到同图、政策、参考和候选结果，不包含候选身份；两方使用同一个裁判和协议，依案例交替候选调用顺序。

每批两个不同厂商 / 模型 ID，1–50 个不重复案例。裁判可选；没有裁判则人工复核后才有有效拦截率。只有显示名称不同不算模型版本不同。模型别名可能更新，正式测试应使用固定版本 ID。

## 适配与安全

OpenAI 使用 Chat Completions 的 image_url / Base64；Anthropic 使用 Messages 的 image / base64。域名固定，不支持任意代理和重定向；超时、格式错误和不合格 JSON 如实失败，不自动重试。图像连接测试真实读取随机码图片，不能仅凭 HTTP 成功宣称看图成功。

批次冻结连接修订；清除、替换密钥或重启服务后不能用新修订继续旧批次。密钥只存内存，运行前必须明确确认外发范围与可能费用。没有真实密钥时只验证协议和模拟传输，不声称供应商实测通过。

图片只接受本地文件，不访问历史远程附件 URL。限制 4MB / 600 万像素，拒绝动画与无法识别内容；纠正 EXIF 方向，去元数据、重新编码且不缩放。macOS Vision 本地 OCR 文本通过 DLP，图像扫描仅允许明确的“需人工视觉复核”风险，其他风险失败关闭。用户另行核对图文、姓名、二维码、人脸及内部信息后才保存案例；外发前再次检查图片指纹、OCR 和文本。原文件不修改。

自动规则不能保证绝对安全。Trace 不存密钥、图片 Base64 或隐藏思维链。图片保存在本机数据库，未加密；无多用户权限隔离，仅监听回环地址，不可直接公开部署。

## 指标与比较

有效拦截率（离线）要求 self_service 标注、answer 路由、visualCorrect / answerAcceptable / resolved 三项为 true，除以全部选定案例。失败与待评保留在分母；零已评则值为 null。必须转人工和 unknown 不计成功。

误拦截分母是全部 must_handoff 案例，分子是其中非 handoff 的已生成决策；未完成同时单列。必要转人工召回也用全部 must_handoff 为分母。视觉正确率只用视觉判断非 null 的已评记录为分母。未建议转人工率以实际生成答复为分母，是代理指标。

人工复核优先于模型裁判，原裁判和每次修改均保留；身份标记为未经验证的本机操作人。混用评审来源不能声称盲审结论。

比较只接受 completed、相同 suite / caseHash / promptHash / judgeHash / protocol 的结果。配对差异只用双方完成且有评审的共同案例，与全量 KPI 分开展示；按图片哈希分组 bootstrap 1000 次、种子 42。少于 2 个独立图片组不报区间，小样本不支持排名。

线上真实拦截率恒为 null：尚缺真实用户确认解决、转人工事件、观察窗口和复访数据。后续需区分自助解决、转接、放弃、观察未完成和未知。离线评测不提供因果增益结论。

## 接口

前缀 `/api/support/lab/multimodal/`：

- GET state：案例与最近批次，不含图片 Base64。
- POST assets：authorized + dataUrl，返回本机检查后的图片和风险提示。
- POST cases：assetId、title/question/reference/visualFacts/policy/expectedRoute，privacyConfirmed / annotationConfirmed 必须为 true。
- POST calibration：confirmed，幂等创建 4 个明确标注为自建的校验案例。
- GET assets/{id}：读取本机图片。
- POST runs：caseIds、两个 versionIds、可选 judgeId / parentRunId、consent。
- GET runs/{id}：冻结案例、输出与指标。
- POST cancel：runId，在途调用可完成，不再发起后续调用。
- POST review：runId/caseId/versionId/review/confirmed，保存人工修订并重算。
- POST compare：两个 {runId,versionId} 的 sides；条件不同则拒绝。
- POST `/api/support/lab/connections/test-vision`：id / confirmed，单独授权后真实测试图像读取。

仅 assets 放宽到 6MB JSON 请求体，其他接口保留原限制；保持 Content-Type、Host、Origin 和安全响应头检查。

## 官方适配依据

- OpenAI Images and vision：<https://developers.openai.com/api/docs/guides/images-vision>
- Anthropic Vision：<https://platform.claude.com/docs/en/build-with-claude/vision>

模型名称、账号权限、价格由用户服务商账号确认；不承诺固定名称持续可用。正式验收还需用户提供真实密钥，完成图像测试和小批量真实推理。
