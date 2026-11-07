# EvalPilot 工作台界面升级

2026-11-05。本次借鉴对象中心的产品组织方法，不复制第三方商标或宣称接入第三方平台。

## 设计依据

参考 Palantir 官方 Object Explorer 与 Object Views 文档：搜索业务对象、查看属性与关系，再进入上下文相关操作；对象面板只保留当前任务的关键内容。

- https://www.palantir.com/docs/foundry/object-explorer/overview/
- https://www.palantir.com/docs/foundry/object-views/overview/

参考页面仅用于产品范式研究。未向外部设计服务发送截图、代码、客户语料或凭证。

## 信息架构与视觉系统

- 统一全站的导航、标题、按钮、表格、状态、明暗模式与间距。使用现有 React、Radix 和 Phosphor，不引入第二套组件库。
- 导航分为构建与探索、评测与洞察、运营与配置；图谱页默认折叠侧栏。功能搜索支持按钮入口和 Cmd/Ctrl+K。
- 项目集增加真实资产概览和“案例→本体→模拟→评测”入口。统计直接来自已有接口，不生成假 KPI。
- 保留现有配色偏好；顶部可一键切换明暗模式。数据、模型调用确认和真实能力边界不变。

## 图谱工作台

- 示例的默认业务布局使用 SVG 对象卡片，真实语料的大图和自由布局继续使用 D3 Canvas。
- 独立的 `ontologyObjectLayout.ts` 管理分组、稳定排序、端口、正交路径和镜头；避免旧实现中卡片尺寸不随缩放缩小、位置却继续挤压的问题。
- 默认镜头最低 78%，对象名为 16px，避免默认把主要文字压成无法阅读的缩略图。窄画布采用可平移视口，而非强行缩到 8%。显式“适应画布”允许进入概览，界面提示放大查看对象。
- 中英文按显示宽度分行；E102 与 A-100 / A-200 同时保留，不用省略号抹掉关键型号。
- 同义、普通业务、候选关系用不同线型/颜色表达。所有节点与边仍来自实际返回的数据，没有为美观伪造业务关系。
- 可拖动卡片、平移、缩放、键盘选择、逐级展开、选择后查看来源；导航缩略图按需展开，避免遮挡关系图。
- 目录按需浮出，不再永久挤占画布。宽屏右侧为固定对象工作区，窄屏为可关闭的覆盖面板。保留原生全屏与页面全屏降级。
- 原右侧业务指令保留，改为“节点详情 / 业务指令”标签。预览、确认、保存、验收门禁、撤销与审计不变。

## 验证方法与边界

```sh
npm run build
node --test tests/ontology-graph.test.ts tests/ontology-object-layout.test.ts
.venv/bin/python -m unittest discover -s tests -p 'test_ontology*.py' -q
EVAL_ONTOLOGY_BASE=http://127.0.0.1:4294 JSDOM_PACKAGE_ROOT=/absolute/path/to/jsdom-package-root node tests/workbench_dom.cjs
EVAL_ONTOLOGY_BASE=http://127.0.0.1:4294 JSDOM_PACKAGE_ROOT=/absolute/path/to/jsdom-package-root node tests/ontology_dom.cjs
EVAL_ONTOLOGY_BASE=http://127.0.0.1:4294 JSDOM_PACKAGE_ROOT=/absolute/path/to/jsdom-package-root node tests/ontology_business_dom.cjs
JSDOM_PACKAGE_ROOT=/absolute/path/to/jsdom-package-root node tests/ontology_commands_dom.cjs
EVAL_ONTOLOGY_BASE=http://127.0.0.1:4294 PLAYWRIGHT_PACKAGE_ROOT=/absolute/path/to/playwright-package-root node tests/ontology_visual.cjs
```

2026-11-05 已完成构建、50 项本体后端测试、15 项原图算法测试、6 项新对象布局测试、原图谱/客服决策/业务指令/全站入口的 DOM 测试。指令写入测试仍使用临时数据库。实际工作区的指令记录未被演示测试污染。

对三种教学布局生成实际 React SVG，经 librsvg 渲染为 1100×510 PNG，检查了全尺寸与缩略图。发现并修正了型号名称截断和非选中对象过暗。默认卡片布局的几何测试检查不重叠、路径绕开非目标卡片；这是程序几何与独立 SVG 预览，不是完整浏览器页面截图。

**未完成：真实浏览器视觉验收。** Chromium 启动受到 macOS MachPort 权限限制。不能将 DOM、SVG 预览或 PNG 尺寸检查称为跨屏幕浏览器验收；全站响应式、字体实际度量、浏览器全屏截图仍需在允许启动浏览器的环境运行视觉脚本。构建仍有原有大资源包告警，本次未用调高告警阈值掩盖它。

验证后，真实语料及两种质检数据保持不变；原导入记录指纹与改动前一致。没有上传、重写原始案例或调用外部模型。
