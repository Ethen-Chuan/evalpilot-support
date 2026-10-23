# 售后客服模型运营 · 验证记录

验证日期：2026-10-21。范围：已有模型连接与实际文本评测记录的只读运营界面，不包含生产发布能力。

## 已通过

- 前端类型检查与生产构建；仍存在原有大包体提醒，不宣称性能优化完成。
- 20 项前端单元测试：新增 6 项运营数据口径测试，另含既有导航与模型选择测试。
- 新版隔离 DOM 操作测试：项目 / 批次筛选、排除本地分类器、失败 / 裁判分类、答复搜索、专用密码窗口、原会话 / Trace 链接、历史编号查询、跨项目拒绝、缺失 / 空结果、切换竞态、读取失败后隐藏旧指标、自动刷新恢复。
- 既有模型连接窗口测试与 14 项供应商连接单元测试通过；使用隔离响应，不发起真实供应商推理。
- Chromium 桌面、390px 手机、产品自身深色切换验证：无页面错误、无整页横向溢出。明细表保留容器内横向滚动。
- 本机真实页面仅作只读核对：已有两条连接仍为已配置且已测试，原双模型结果与逐例证据正常加载，未触发 POST 或新增模型调用。未重启后端。

## 数据与边界

测试截图全部使用构造数据，未加入源码目录。源码只包含测试夹具，不含客户数据、密钥、实际评测导出或截图。

自动规则命中的比例表达式和安全说明已核对；没有因“不得输入未经授权的机密资料”触发关键字而删除该提示。以上规则检查与人工复核不构成绝对安全保证。

本次没有验证持续线上可用性、真实派单 / 坐席接口、生产灰度 / 回滚、吞吐压测或长期稳定性。旧规则沙盒留存兼容，但不再作为正式运营功能展示。

## 复现

```sh
npm run build
node --test tests/modelops-data.test.ts tests/lab-navigation.test.ts tests/comparison-selection.test.ts
JSDOM_PACKAGE_ROOT=/path/to/jsdom-project node tests/modelops_dom.cjs
JSDOM_PACKAGE_ROOT=/path/to/jsdom-project node tests/model_connection_window_dom.cjs
python3 -m unittest discover -s tests -p 'test_provider_connections.py' -v
```

DOM 测试无需后台服务，禁止状态变更与外部请求，所有响应均来自独立构造夹具。
