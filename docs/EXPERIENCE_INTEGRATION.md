# 业务指标与质检复核接口

结果大盘统一为业务指标、质检复核、DSAT归因、意图树四页。现有文本/图文模型比较继续使用原接口。此模块不执行真实派单、退款或坐席转接；不把历史摘要建议分作为独立模型准确率。

## 本机接口

所有写请求要求同源、`Content-Type: application/json`，整体请求不超过256000字节。此服务面向本机，不应直接暴露公网；没有多租户鉴权。

| 方法 | 路径（前缀 `/api/support/experience`） | 用途 |
| --- | --- | --- |
| GET | `/state?project=项目ID&run=文本批次ID&mmrun=图文批次ID&replay=本地学习批次ID` | 项目指标、学习结果、规则、复核、归因、树与趋势；参数可省略 |
| GET | `/examples?project=项目ID&intent=意图叶子ID&page=1` | 浏览全部含该来源意图的正式对话，每页20条，不按训练条件隐藏多意图或无效标注案例 |
| GET | `/experiments?project=项目ID&scope=active&q=关键词&status=all&training=all&page=1` | 全历史学习实验，按创建时间倒序，每页10条；scope为active/favorites/archived |
| POST | `/experiment-update` | 修改名称、备注、收藏；不允许编辑成绩和训练参数 |
| POST | `/experiment-archive` | 单条/批量软归档或恢复，全部校验通过才一次写入 |
| POST | `/start-replay` | `projectId, count, trainingPercent:25/60/100, confirmed:true`；比例可省略默认100，不改变测试分组；回放1–500条且不超过独立测试集 |
| POST | `/stop-replay` | `id`，停止后续本地回放，保留已完成/在途结果 |
| POST | `/outcomes` | `projectId, confirmed:true, records`，批量1–100条 |
| POST | `/review` | `id, revision, verdicts, reason, reviewer, confirmed:true` |
| POST | `/judge` | `projectId, caseIds, count, connectionId, consent:true`，1–50条 |
| POST | `/cancel` | `id`，停止该质检批次后续请求，保留在途结果 |
| GET | `/rca-detail?project=项目ID&id=归因ID` | 当前项目对应来源证据、全部文字消息和缺失提示，不推测会话关联 |
| POST | `/rca` | `id, projectId, revision, primary, contributors, checks, evidence, counterfactual, action, owner, reviewer, confirmed, status, verification` |

编号不存在、缺授权、字段错误、并发修改、隐私扫描不通过时拒绝写入。不可把错误或缺失当作0分或成功。错误状态和逐条Trace可追溯。

### 实验管理接口约束

- 列表覆盖全部本项目`cx_replay`，不截断到30条。返回`records,total,page,pages,pageSize,counts`，每页10条；counts是项目级分类计数，total是组合筛选后的匹配数。favorites只包含未归档收藏。status可选all/completed/running/failed/cancelled/interrupted，training可选all/25/60/100；q最多200字，搜索名称、备注、编号或创建时间，不持久化搜索文本。
- `experiment-update`请求为`{projectId,id,revision,name?,note?,favorite?}`。至少一个修改字段；name最多80字，note最多500字，空字符串清空；favorite必须是布尔值。文本经过现有本机脱敏门禁；指标、参数等其他字段拒绝写入。
- `experiment-archive`请求为`{projectId,records:[{id,revision}],archived:true|false,confirmed:true}`，一次1至100条，不接受重复、跨项目、过期版本。归档运行中实验会拒绝整批；全部通过后在同一事务提交，恢复时保留收藏与备注。
- 管理信息单独保存于`cx_replay_meta`，初始revision为0，每次更新递增。不会被后台训练任务覆盖，也不会改写原实验、结果或Trace。旧实验默认命名按训练档位和测试量派生，无需迁移。
- `state.learning`返回`recordCount`代替旧`runs`下拉框摘要；当前run和可比history附带metadata。默认选择最新未归档实验；全归档则run为空。明确传replay可打开归档实验，历史曲线仍保留全部可比批次。页面打开后锁定当前实验供轮询，归档不会偷偷切换成绩。
- 实验窗口提供手动刷新；筛选、换页和刷新清空当前页勾选。不同窗口改同一条记录时按revision拒绝覆盖，用户取消编辑后重新读取再提交。

## 正式对话本地学习

`learning.inventory`提供来源/合格/排除数量、训练/验证/测试分布、转人工正负标签数。`learning.run`提供真实预测、来源标注、逐例Trace和字段准确率；服务启动不会自动虚构学习结果，需显式发起。首个有效用户提问之前的上下文才是模型输入，后续人工回复只作界面证据。来源整段标签可能依赖后续信息，当前协议仅是首轮分类诊断。

意图浏览与学习样本分开：`examples.total`为包含当前意图标签的来源对话数，`singleIntent + multipleIntents = total`；同一多意图对话可出现在多个分支，但每个分支按对话去重。`eligibleTotal`才是符合当前单标签意图学习条件的数量；`excluded`提供互斥的首要筛选原因，和eligibleTotal相加等于total。`cases`分页返回原始意图数组、可学习标记及原因，未入选单标签意图学习仍能打开完整对话，且不改变其他字段的学习资格。页码超出末页时返回末页；非法页码拒绝。

排除显式无效对话；多值或冲突字段不参与该字段学习。保留有转人工标签但没有意图的案例。同一匿名用户或重复标准化首问通过连通分组分配训练/验证/测试，分组大小不同，因此实际比例不保证严格等于70/15/15。字符TF-IDF和各字段线性分类器只在训练组拟合，不根据测试分数调参；验证组目前保留未使用。

字段准确率分母为已回放案例中具有该来源标签的字段，漏输出计错；Macro F1也将漏输出计作来源类别的漏检。字段完全无法预测时显示null。路由测试仅一种标签时总体准确率显示null；转人工正例召回、漏判和未输出另外披露，来源“直接转人工”不是安全策略的必转人工金标。基础填单仅包括意图、匿名产品类别、故障域三项，不能代表完整工单准确率。

每批固定参数重新训练，按固定顺序选测试子集，保存输入协议和来源/案例指纹；新批次不覆盖旧批次，也不与旧行为Agent的不同划分直接排名。批次存为`cx_replay`，无模型供应商调用，不上传对话，不发布知识条目。服务重启时运行中任务标记interrupted。端点本身不接收新对话，新增语料仍须走项目原有脱敏导入流程。

## 会话结果结构

以下仅是接口结构，不是业务成绩。必须换成经授权的实际结果；新接入先使用`sandbox`。日期须含时区且不晚于当前时间，`startedAt <= closedAt <= observedUntil`。

```json
{
  "projectId": "替换为实际项目ID",
  "confirmed": true,
  "records": [{
    "id": "ANON-SESSION-EXAMPLE",
    "environment": "sandbox",
    "source": "匿名测试来源",
    "evidence": "结构校验用途，不是真实生产结果",
    "startedAt": "2026-09-01T01:00:00Z",
    "closedAt": "2026-09-01T01:10:00Z",
    "observedUntil": "2026-09-04T01:10:00Z",
    "resolved": null, "recontact": null, "handoff": null,
    "mustHandoff": null, "unsafe": null, "answered": null,
    "ticketResolved": null, "rating": null, "traceId": null,
    "expectedIntent": null, "predictedIntent": null,
    "tools": [], "form": null, "quality": null
  }]
}
```

- `id`为3–65位匿名字母数字/下划线/短横线编号，以字母开头；同项目同编号幂等，内容冲突整批拒绝，不覆盖历史。不同项目分别计数。
- 七个结果布尔字段必须显式给出；未知用null，不能省略或写字符串。`recontact`指结束后72小时内同一问题再次联系；`mustHandoff`依据适用业务规则和明确人工诉求。
- `environment`仅production/sandbox；source与evidence必填并经过本机脱敏门禁。平台没有独立核验生产来源，不能把来源声明称为平台实证。
- `rating`仅1–5整数或null，DSAT为1–2，满意为4–5；分母是有评价的生产会话。
- `traceId`可为空，否则须先通过现有Trace接口入库，不能引用不存在的轨迹。外部轨迹保留来源声明，不伪装本机执行。
- `tools`项为`{"name":"匿名工具名称","success":true}`，每次调用一项；成功状态不等于业务已解决。
- `form`为`{"expected":{"问题类型":"故障"},"predicted":{"问题类型":"故障"},"goldConfirmed":true}`；两侧各最多30个文本字段。字段准确率按expected逐项精确对照，缺项计错；整单精确一致同时校验额外字段。不做模糊匹配。
- `quality`为`{"expected":false,"predicted":true,"goldConfirmed":true,"independent":true,"ruleVersion":"service-qc-20261014-v1"}`；布尔表示是否合格。gold与独立性由接入方确认，平台不自动证明它们。原分、规则建议、摘要人工复核和摘要裁判不能填作独立全会话测试金标。
- 两个意图字段使用当前意图树的叶子ID；未知为null。原始多标签仍保留在项目案例里。

## 指标口径

- 线上有效拦截：production且结束、观察均满72小时，`resolved/recontact/handoff/mustHandoff/unsafe`全明确的会话为分母；resolved=true且后四项全false为分子。未成熟、字段不全单列；仅针对覆盖样本，不外推全量。无已成熟完整样本显示待接入。
- 安全护栏：上述完整会话中mustHandoff=true为分母，handoff=false为分子。不得以提高拦截率阻止必要转人工。
- 填单字段准确率、整单一致率和独立质检准确率均只取production中的有效对照；空分母为null。
- 全链路覆盖是各阶段独立会话计数，不是严格漏斗转化。每日趋势按UTC结束日期分组，缺失值不补0。
- 模型图表默认展示选中批次的逐例累计准确率；历史曲线只汇总相同bundleId/caseHash/protocol/judgeHash的完成批次，至少2批才启用。累计不是时间趋势，不能解释为持续学习。图文专项独立标注自建或来源声明真实；历史图文未绑定项目，不进入项目线上指标。
- 所有比率保留分子分母。无随机分流或可靠对照，不能将这些统计解释为Agent的因果收益。

## 复核、归因与保留历史

`state.qualityAnalytics`提供复核口径，所有比率为`{value,numerator,denominator}`，百分比0–100，空分母为null：

- `changedRate`：明确改判 /（明确改判 + 明确维持），仅覆盖有可核对结论的摘要。
- `coverage`：上述可核对摘要 / 全部导入摘要；不能把覆盖率误叫改判率。
- `localCompletion`：本平台已保存人工复核 / 全部导入摘要，与来源复核状态分开。
- `slices`：changed/maintained/unresolved/conflict四类，count相加等于total，value的分母均为total。`classifications`是记录ID到类别的映射，用于前端筛选。

要求明确的原判合格/不合格。同规则版本本平台人工复核优先；否则来源「维持原判」记maintained，「调整为合格」需原判不合格，「降级为不合格」需原判合格，前后不符记conflict。模糊的「已通过/不通过/部分通过」记unresolved；原分、建议分、裁判辅助分均不用于推断。各类数量仅从当前项目记录计算，源码不携带私有项目统计。

`#overview?tab=quality&qc=changed`等深链接定位对应分类；图例点击与来源记录联动，不篡改数据。

`state.modelAnalysis`提供当前完成文本批次的`models`与`cumulative`：保留去重后的原caseIds顺序；每个(versionId,caseId)只允许一条结果，重复记conflict，批次外结果不计。意图正确与否由expectedIntent和实际output.intent重新精确对照，不信任缓存的intentMatch。每个模型保留correct/completed/failed/missing/conflict；分母是全部选定案例，累计分母是当前前缀案例数，而不是仅成功输出数。没有有效完成输出时value=null，不伪造零分或版本差值。`trend.correct/total`与此口径一致。该口径比仅成功输出分母更保守，展示失败数便于核查。

质检规则100分起评、低于90分不合格。7个一级维度各选violated/clear/unknown，同一级一次扣分，观察维度0分。计分维度有unknown则不能确认总分。原分与建议不覆盖，提交要求当前整数revision，保存历史和Trace。

裁判发送渠道、匿名记录ID、机审摘录及完整脱敏规则；不发送原分、建议或人工意见。规则、提示词、输入都有摘要指纹。需要已测试连接及本次授权，Key只在既有本机内存保险库中。每条最多一次调用；不自动重试。输出结构/证据校验不通过则失败，不强行补分。服务重启将运行中批次置为interrupted，已完成结果保留。

production的来源声明低评价会话创建待归因记录。另从同项目已有complaint标签的完整对话派生conversation_signal，保留多意图；GET只读取，首次保存才持久化，不修改源会话或金标。review_signal保留原来源。派生ID由项目和来源ID确定，重复读取/保存不重复计数。只有能关联同项目production的1–2分结果才计入scope=dsat，缺来源自动降为线索并禁止确认；不按投诉情绪造评价。

`rcaAnalytics`按dsat/signals分别返回total、statuses、confirmationRate（已确认/总数）、verificationRate（已验收/已确认）、causes（一个主因计一次）、coverage（已导入对话/低分评价/Trace）。全部比率空分母为null。材料存在不等于已核验，线索确认不将其转成DSAT。

六类原因policy/knowledge/understanding/engineering/tool/human，`checks`是原因ID到`{verdict:unknown/supported/excluded,note}`的映射，未填写默认为unknown，支持/排除须有note。triage可无主因并保存部分草稿；其他状态要求一个主因及每个促成因素均supported，证据、反事实、动作、负责人、复核人必填，confirmed必须为true。verified必须从fixing/verified进入且有实际人工回归证据。保存校验revision，追加history及reviewTraceId；不覆盖原材料，不自动宣称修复或确定责任。

`learning.history`仅包含与所选批次sourceHash/caseHash/protocol相同的实际完成批次，每项含trainCount、trainingPercent及三项带分母成绩。新增trainingHash记录实际训练子集，25/60/100%从固定排序的训练侧嵌套取样，最少10条；测试侧与分组隔离不变。重跑不是梯度累积轮次，重复条件可重现相同结果。

真实复核数据与完整规则只存本机数据库，不随源代码示例或Git仓库分发。首次空数据库不会自动生成客户数据或实测成绩。
