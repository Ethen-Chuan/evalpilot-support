# 售后图文与转人工评测协议

更新：2026-10-14。协议：`aftersales-vision-containment-v1`。

## 范围与公平性

单轮文字与单张 PNG/JPEG，不是闭环用户模拟或生产转接。没有模型密钥时不制造分数。自建校验为 calibration，用户声明真实数据为 real，公开照片改编为 public；三类不能混跑。旧文本记录保留。

## 图片案例入口

首次打开时优先选择有可用图片的真实售后，其次公开照片，再次自建校验；不会固定停留在零条的真实来源。用户主动切换来源后，轮询不会覆盖其选择。每个来源显示可用条数，图片文件缺失或指纹信息不符的案例禁止选择。

案例卡片直接读取本机PNG缩略图，点击打开图片、问题、政策、视觉事实、参考答复与来源。数量只从当前来源的可用案例中选择。开始评测仍须配置两个通过看图测试的模型并明确授权外发；查看图片和导入案例不调用模型。

内置20张VisA官方完整板卡照片和4张已审核示例局部，CC BY 4.0，署名与变更说明在`backend/public_vision/ATTRIBUTION.md`及案例预览中。图片裁掉答案色框并去除元数据，没有补画；中文问题、参考和政策为演示改编，不是用户工单，也不是完整VisA独立基准。公开照片不会混入真实售后或线上业务KPI。它们只验证图文流程和证据边界，低分辨率不能作为通电安全、器件功能或保修的判断依据。

`POST public-examples`须confirmed=true，逐图验证包指纹、本地DLP和文本；全部通过后事务保存，失败无部分入库。24张固定图片已逐张人工视觉核对，使用固定SHA-256审核清单，而不是伪装OCR通过；`automaticTextScan=not_run_fixed_public_review`、`ocrCharacters=null`及`publicReview`留存检查方式。一个字节变化即失去固定审核资格，且仍需本地DLP通过。已知公开素材不能再次声明为用户真实工单。重复准备幂等，不覆盖已有案例或制造结果。无网络下载动作：使用随源码提供的已审核公开照片包。原数据集的图片消息数仅为导入清单中的隔离计数，绝不冒充可评测图片数量；此功能不自动访问原客户图片链接。

本机原生Vision OCR在本次运行环境对普通图片返回错误，任意用户上传仍失败关闭，没有扩大白名单。修复该环境扫描器前，不能声称新客户图片导入已验收。程序生成的E04/E09校验或随机看图连接测试另行校验原始绘图文本及精确PNG字节，DLP仍必须通过；结果标记generated_text_scanned，不假报OCR完成。随机验证码不会提供给候选模型，读错仍不允许用于图文评测。这两类确定内容审核不适用于任意客户图片。

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

- GET state：案例与最近批次，不含图片 Base64。新增`inventory.real/public/calibration/missingImages/withheldImageMessages`与案例`imageAvailable`。
- POST assets：authorized + dataUrl，返回本机检查后的图片和风险提示。
- POST cases：assetId、title/question/reference/visualFacts/policy/expectedRoute，privacyConfirmed / annotationConfirmed 必须为 true。
- POST calibration：confirmed，幂等创建 4 个明确标注为自建的校验案例。
- POST public-examples：confirmed，幂等、事务补齐24个公开照片改编案例（20张官方原始板卡照片+4张已审核局部图），保留已有案例及批次；返回caseIds与suite=public，不调用模型。
- GET assets/{id}：读取本机图片。
- GET images/{id}：验证PNG内容及资产SHA-256后返回image/png，供浏览器缩略图使用；不存在或指纹错误时拒绝展示。不接收文件路径或外部URL。
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
