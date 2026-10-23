# ModelOps 验证记录

> 历史归档：2026-10-21 正式界面已改为售后客服真实评测记录工作台。以下是旧规则沙盒的历史验证，不是当前页面或生产能力的验收。新版功能和测试入口见 MODELOPS_PORTFOLIO.md；下方旧 DOM 复现步骤已由新版隔离测试替代。

验证日期：2026-10-17。仅覆盖本机沙盒，不代表真实模型供应商、车辆或集群验收。

## 已执行检查

- 前端生产构建通过；保留既有大包体提醒，没有伪装为性能优化完成。
- 新增后端测试十二项全部通过：初始实际基线执行、标签不进入规则决策、缺失 / 失败 / 指纹异常的门禁拒绝、灰度晋级回滚、共同故障域、兜底不掩盖失败、回流使旧门禁失效、相同故障条件验收、持续故障不能被一次重试修好、并发与隐私门禁、严格参数、统计分母和 P95、读取接口契约。
- 全量后端 184 项中 183 项通过；既有 `test_full_local_session_not_limited_by_state_recent_thirty` 固定日期排序测试仍失败。没有为本次改动调整无关测试。
- 既有前端模型选择 / 导航十四项全部通过。
- 隔离 DOM 端到端通过：从空工作区创建、反例发布阻止、灰度、晋级、动态批次切换、故障注入、回滚、人工 RCA、回流、重新评测、验收关闭、Trace 往返。
- HTTP 实际校验：非 JSON 请求返回 415；不允许的 Origin 返回 403。
- Chromium 桌面 / 手机视觉复核：运行曲线、版本与门禁面板可读；手机视口无整页横向溢出，明细表允许容器内滚动。桌面首次缩到手机时应等待侧栏过渡完成。

所有流程使用单独的临时数据目录，自动化禁止请求外部服务、禁止修改客服业务接口。测试不会向原客户项目写入构造案例。

## 复现

```sh
npm ci
npm run build
.venv/bin/python -m unittest discover -s tests -p test_modelops.py -v
node --test tests/lab-navigation.test.ts tests/comparison-selection.test.ts
```

页面集成测试需要 Node.js、独立安装的 jsdom 26，以及真实兼容的本机 DLP 扫描器（不使用无条件通过替身）。先在单独终端启动：

```sh
EVAL_DATA_DIR=/tmp/modelops-browser-local PORT=4296 .venv/bin/python tests/modelops_browser_server.py
```

随后运行：

```sh
JSDOM_PACKAGE_ROOT=/absolute/path/to/isolated-jsdom-project node tests/modelops_dom.cjs
```

该临时目录需要以 `modelops-browser-` 开头且不能是项目 `data/`，首次必须为空沙盒。复跑时使用新的临时目录，勿删除真实项目数据。后端单元测试的扫描器替身仅在隔离测试内生效，生产路径仍采用原扫描器门禁。

## 安全与尚未覆盖

新增源码、说明和测试完成自动规则复核；比例配置等命中经人工核对为演示规则。截图只来自隔离构造数据，未加入源码仓库。未上传任何客户数据库、实际模型文件或 Key。自动规则未发现明确敏感项不保证绝对安全。

尚未完成真实服务压测、长时间运行、断电恢复、分布式一致性、多租户隔离与真实车辆安全验证；不将这些边界写成已完成。
