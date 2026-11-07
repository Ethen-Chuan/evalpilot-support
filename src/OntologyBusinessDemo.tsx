import { useEffect, useRef, useState } from 'react';
import { ArrowRight, CheckCircle, CircleNotch, Graph, Play, ShieldCheck, WarningCircle } from '@phosphor-icons/react';
import type { Resolution } from './ontologyGraph';
import './ontology-business.css';

type TaskInput = { text: string; confirmedModel: string; proposedAction: string };
type Expected = { documents: string[]; candidates: string[]; nextAction: string; actionBlocked: boolean; tool: string };
type Scenario = { id: string; name: string; goal: string; input: TaskInput; expected: Expected };
type Document = { id: string; title: string; content: string; source: string; version: string; nodeId: string };
type Catalog = { protocol: string; cases: Scenario[]; models: { id: string; label: string }[]; entityLabels: Record<string, string>; documents: Document[]; comparisonMethod: string; boundary: string; knowledgeVersion: string; schemaVersion: string };
type Step = { id: string; title: string; status: string; durationMs: number; input: unknown; output: unknown; nodeIds: string[]; edgeIds: string[] };
type Check = { id: string; title: string; passed: boolean };
type Result = { protocol: string; id: string; createdAt: string; input: TaskInput; schemaVersion: string; schemaHash: string; knowledgeVersion: string; knowledgeHash: string; context: { mappings: Resolution['mappings']; modelIds: string[]; unknownModels: string[]; codes: string[] }; comparison: { literal: { id: string; title: string; matchedBy: string[] }[]; normalized: { id: string; title: string; matchedBy: string[] }[]; selected: Document[]; excluded: { id: string; title: string; reason: string }[] }; query: { allowed: boolean; tool: string; reason: string; arguments: unknown }; outcome: { title: string; nextAction: string; reason: string; actionBlocked: boolean; actionReason: string; candidateIds: string[]; candidateNames: string[]; draft: { kind: string; facts: { label: string; basis: string }[]; candidates: string[]; references: string[]; nextStep: string; unknowns: string[] } }; checks: Check[]; steps: Step[]; graph: Resolution; boundary: string };
type Suite = { total: number; passed: number; suiteVersion: string; suiteHash: string; boundary: string; rows: { id: string; name: string; passed: boolean; input: TaskInput; expected: Expected; actual: Expected; checks: { id: string; name: string; passed: boolean }[] }[] };
const initial: TaskInput = { text: '我的主机报 E102，开不了机。', confirmedModel: '', proposedAction: 'review' };
const actionNames: Record<string, string> = { clarify_model: '核实型号', clarify_code: '核实故障码', clarify_context: '补充现象', check_external_state: '核实外部状态', professional_review: '专业复核', manual_review: '人工核实未覆盖问题' };
const toolNames: Record<string, string> = { skipped: '没有调用知识查询', lookup_fault_knowledge: '按型号 + 代码查询故障知识', lookup_symptom_knowledge: '按规范症状查询核实方法' };
const quickCases = ['missing-model', 'alias-startup', 'model-b', 'unsafe-replace'];
const sameInput = (left: TaskInput, right: TaskInput) => left.text === right.text && left.confirmedModel === right.confirmedModel && left.proposedAction === right.proposedAction;

export function OntologyBusinessDemo({ focusGraph, invalidateGraph }: { focusGraph: (resolution: Resolution, label: string) => void; invalidateGraph: () => void }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loadingError, setLoadingError] = useState('');
  const [retry, setRetry] = useState(0);
  const [input, setInput] = useState(initial);
  const [result, setResult] = useState<Result | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [stepId, setStepId] = useState('gate');
  const [suite, setSuite] = useState<Suite | null>(null);
  const [checking, setChecking] = useState(false);
  const [suiteError, setSuiteError] = useState('');
  const runController = useRef<AbortController | null>(null);
  const suiteController = useRef<AbortController | null>(null);
  const currentInput = useRef(input);
  const output = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoadingError('');
    fetch('/api/support/ontology/business/catalog', { signal: controller.signal }).then(async response => {
      const value = await response.json();
      if (!response.ok || value.protocol !== 'ontology-business-v1') throw new Error('当前服务未加载新版业务演示，请打开新版服务或重启平台，再重试。');
      if (!controller.signal.aborted) setCatalog(value);
    }).catch(problem => { if (!controller.signal.aborted) setLoadingError(problem instanceof Error ? problem.message : '业务演示读取失败'); });
    return () => controller.abort();
  }, [retry]);
  useEffect(() => () => { runController.current?.abort(); suiteController.current?.abort(); }, []);
  const change = (next: TaskInput) => {
    runController.current?.abort(); currentInput.current = next; setInput(next); setResult(null); setError(''); setRunning(false);
    invalidateGraph();
  };
  const run = async (next = currentInput.current) => {
    runController.current?.abort();
    const controller = new AbortController();
    runController.current = controller;
    setRunning(true); setError(''); setResult(null);
    invalidateGraph();
    try {
      const response = await fetch('/api/support/ontology/business/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next), signal: controller.signal });
      const value = await response.json();
      if (controller.signal.aborted || !sameInput(next, currentInput.current)) return;
      if (!response.ok || value.protocol !== 'ontology-business-v1') throw new Error(value.error || '业务演示未完成，请检查当前服务版本。');
      setResult(value); setStepId(value.query.allowed ? 'lookup' : 'gate');
      requestAnimationFrame(() => output.current?.scrollIntoView({ block: 'nearest', behavior: 'auto' }));
    } catch (problem) { if (!controller.signal.aborted) setError(problem instanceof Error ? problem.message : '业务演示未完成'); }
    finally { if (!controller.signal.aborted) setRunning(false); }
  };
  const verify = async () => {
    suiteController.current?.abort();
    const controller = new AbortController(); suiteController.current = controller;
    setChecking(true); setSuiteError(''); setSuite(null);
    try {
      const response = await fetch('/api/support/ontology/business/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmSynthetic: true }), signal: controller.signal });
      const value = await response.json();
      if (controller.signal.aborted) return;
      if (!response.ok || value.protocol !== 'ontology-business-v1') throw new Error(value.error || '固定验收未完成');
      setSuite(value);
    } catch (problem) { if (!controller.signal.aborted) setSuiteError(problem instanceof Error ? problem.message : '固定验收未完成'); }
    finally { if (!controller.signal.aborted) setChecking(false); }
  };
  const describeEntities = (identifiers: string[]) => identifiers.map(identifier => catalog?.entityLabels[identifier] || identifier).join('、');
  const scenario = catalog?.cases.find(item => sameInput(item.input, input));
  const step = result?.steps.find(item => item.id === stepId);
  const selectScenario = (identifier: string) => { const selected = catalog?.cases.find(item => item.id === identifier); if (selected) change(selected.input); };
  const continueWithModel = (identifier: string) => { const next = { ...input, confirmedModel: identifier }; change(next); void run(next); };
  if (loadingError) return <section className="ob-state" role="alert"><WarningCircle size={26} /><h2>业务演示尚未就绪</h2><p>{loadingError}</p><button className="ontology-button" onClick={() => setRetry(value => value + 1)}>重试加载</button></section>;
  if (!catalog) return <section className="ob-state" role="status"><CircleNotch className="spin" size={26} />正在加载业务场景与知识依据…</section>;
  return <section className="ontology-business" aria-label="本体驱动的客服决策演示">
    <header className="ob-heading"><div><span className="ob-eyebrow">任务 → 决策 → 证据 → 验收</span><h2>从客户报障，到有依据的下一步。</h2><p>本体统一说法和适用范围，知识库提供内容，规则决定能查什么、能做什么。图谱用来解释决策，而不是替代决策。</p></div><span className="ob-local"><ShieldCheck size={16} />合成案例 · 本机执行</span></header>
    <div className="ob-input-panel">
      <aside className="ob-scenarios"><h3>选择一个业务问题</h3>{quickCases.map((identifier, index) => { const item = catalog.cases.find(candidate => candidate.id === identifier)!; return <button key={identifier} aria-pressed={scenario?.id === identifier} onClick={() => selectScenario(identifier)}><span>0{index + 1}</span><strong>{item.name}</strong><ArrowRight size={14} /></button>; })}<label>完整场景<select aria-label="选择业务演示场景" value={scenario?.id || ''} onChange={event => selectScenario(event.target.value)}><option value="" disabled>自定义输入</option>{catalog.cases.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label></aside>
      <form className="ob-task-form" onSubmit={event => { event.preventDefault(); void run(); }}><div className="ob-task-goal"><span>{scenario ? '这条任务要解决什么' : '自定义匿名问题'}</span><p>{scenario?.goal || '按当前输入重新检查词典、查询条件与权限。不使用固定案例的预期答案给自定义问题打分。'}</p></div><label>客户问题<textarea aria-label="业务演示客户问题" value={input.text} maxLength={500} rows={2} onChange={event => change({ ...input, text: event.target.value })} /></label><div className="ob-form-options"><label>客户补充的型号<select aria-label="客户补充的型号" value={input.confirmedModel} onChange={event => change({ ...input, confirmedModel: event.target.value })}><option value="">尚未补充，按原话判断</option>{catalog.models.map(model => <option key={model.id} value={model.id}>{model.label}（用户补充，未核验设备）</option>)}</select></label><label>待检查的处理建议<select aria-label="业务演示处理建议" value={input.proposedAction} onChange={event => change({ ...input, proposedAction: event.target.value })}><option value="review">核实信息，准备专业复核</option><option value="replace">直接换件（验证是否被拦截）</option></select></label></div><div className="ob-run-row"><span>不会调用大模型、派单或执行换件</span><button type="submit" className="ontology-button primary" disabled={running || !input.text.trim()}>{running ? <CircleNotch className="spin" size={16} /> : <Play size={16} />}{running ? '正在执行…' : '运行这条客服任务'}</button></div>{error && <p className="ob-error" role="alert">{error}</p>}</form>
    </div>
    {!result && <div className="ob-waiting" role="status"><span>{running ? '正在运行本机查询与检查' : '尚未运行，不预填结果'}</span><p>运行后会显示：找到了哪些知识、排除了哪些条目、为什么先澄清或转复核，以及每一步的实际输入输出。</p></div>}
    {result && <div ref={output} className="ob-results">
      <section className={'ob-outcome' + (!result.query.allowed || result.outcome.actionBlocked ? ' needs-check' : '')} aria-label="本次处理结果"><div><span>本次处理决定 · 不是故障确诊</span><h3>{result.outcome.title}</h3><p>{result.outcome.reason}</p>{result.outcome.actionBlocked && <p className="ob-action-block"><ShieldCheck size={16} />直接换件建议已拦截；不会执行换件。</p>}</div><div className="ob-outcome-facts"><span>{toolNames[result.query.tool]}</span><strong>{result.comparison.selected.length} 条知识被实际引用</strong><small>{result.outcome.candidateNames.length ? `候选：${result.outcome.candidateNames.join('、')}（未确诊）` : '未输出候选部件'}</small></div>{result.outcome.nextAction === 'clarify_model' && !input.confirmedModel && !result.context.modelIds.length && !result.context.unknownModels.length && <div className="ob-follow-up"><span>演示客户补充信息，再继续同一任务：</span>{catalog.models.map(model => <button key={model.id} onClick={() => continueWithModel(model.id)}>补充 {model.label} 并继续<ArrowRight size={14} /></button>)}</div>}</section>
      <section className="ob-comparison" aria-label="检索条件前后对照"><header><h3>同一句问题，知识候选如何变化？</h3><p>前两列只是可复现的简化检索对照，不能当作“普通大模型一定会出错”。信息不足时，最后一列可以是 0。</p></header><div className="ob-comparison-grid">{([{ title: '只按标准词与代码', caption: '不认识别名，不限定型号', items: result.comparison.literal }, { title: '增加术语归一', caption: '口语 → 标准概念，仍未做范围筛选', items: result.comparison.normalized }, { title: '执行查询条件与约束', caption: '业务流程实际允许引用的知识', items: result.comparison.selected }] as const).map((column, index) => <article key={column.title} className={index === 2 ? 'selected' : ''}><span>0{index + 1}</span><h4>{column.title}<b>{column.items.length}</b></h4><p>{column.caption}</p><ul>{column.items.map(item => <li key={item.id}><strong>{item.title}</strong><small>{item.id}</small></li>)}</ul>{!column.items.length && <p className="ob-empty-pool">{index === 2 && !result.query.allowed ? '条件不足，不执行知识查询' : '没有命中条目'}</p>}</article>)}</div>{!!result.comparison.excluded.length && <details className="ob-exclusions"><summary>为什么不引用其他 {result.comparison.excluded.length} 条候选？</summary>{result.comparison.excluded.map(item => <p key={item.id}><strong>{item.title}</strong><span>{item.reason}</span></p>)}</details>}</section>
      <section className="ob-execution" aria-label="业务执行记录"><div className="ob-step-list"><h3>本次执行记录</h3><p>记录可观察操作，不展示或编造模型思维。只保留在当前页面。</p>{result.steps.map((item, index) => <button key={item.id} aria-pressed={stepId === item.id} onClick={() => setStepId(item.id)}><span>{index + 1}</span><div><strong>{item.title}</strong><small>{item.status === 'skipped' ? '未执行 · 条件不足' : item.status === 'blocked' ? '已检查 · 触发限制' : '已执行'} · {item.durationMs} ms</small></div><ArrowRight size={14} /></button>)}</div>{step && <div className="ob-evidence" aria-live="polite"><header><span>执行依据</span><h3>{step.title}</h3></header><StepEvidence step={step} result={result} entityLabels={catalog.entityLabels} /><div className="ob-evidence-actions"><button className="ontology-button" disabled={!step.nodeIds.length} onClick={() => focusGraph({ ...result.graph, activeNodeIds: step.nodeIds, activeEdgeIds: step.edgeIds }, `${step.title} · ${result.id}`)}><Graph size={15} />在图谱中核对这一步</button><button className="ontology-button" onClick={() => focusGraph(result.graph, `完整决策依据 · ${result.id}`)}>查看完整决策依据<ArrowRight size={15} /></button></div><details className="ob-raw"><summary>实际输入与输出</summary><h4>输入</h4><pre>{JSON.stringify(step.input, null, 2)}</pre><h4>输出</h4><pre>{JSON.stringify(step.output, null, 2)}</pre></details></div>}</section>
      <div className="ob-run-foot"><span>本次编号 {result.id} · {result.schemaVersion} · {result.knowledgeVersion}</span><details><summary>版本校验指纹</summary><code>Schema: {result.schemaHash}<br />Knowledge: {result.knowledgeHash}</code></details><p>“检查通过”只表示输出符合所列结构约束，不代表维修结论正确；离开本页不保存本次记录。</p></div>
    </div>}
    <section className="ob-acceptance" aria-label="本体流程固定验收"><header><div><span className="ob-eyebrow">回到评测平台的价值</span><h3>把“应该怎么做”变成可复跑的验收案例。</h3><p>逐条检查知识与候选集合、下一步与查询路径、换件权限和证据。固定预期独立于运行逻辑，不用页面文案自证正确。</p></div><button className="ontology-button" disabled={checking} onClick={() => void verify()}>{checking ? <CircleNotch className="spin" size={16} /> : <Play size={16} />}{checking ? '正在验收…' : `运行 ${catalog.cases.length} 条固定验收`}</button></header>{suiteError && <p className="ob-error" role="alert">{suiteError}</p>}{suite ? <div className="ob-suite-result"><p role="status"><strong>{suite.passed} / {suite.total}</strong> 条符合固定预期。{suite.boundary}</p><div>{suite.rows.map(row => <details key={row.id} className={row.passed ? 'passed' : 'failed'}><summary>{row.passed ? <CheckCircle size={17} /> : <WarningCircle size={17} />}<span>{row.name}</span><small>{row.passed ? '符合预期' : '与预期不一致'}</small></summary><div className="ob-suite-detail"><p>{row.input.text}</p><dl><div><dt>预期下一步 / 实际</dt><dd>{actionNames[row.expected.nextAction]} / {actionNames[row.actual.nextAction]}</dd></div><div><dt>预期知识 / 实际</dt><dd>{row.expected.documents.join('、') || '不引用'} / {row.actual.documents.join('、') || '不引用'}</dd></div><div><dt>预期候选 / 实际</dt><dd>{describeEntities(row.expected.candidates) || '无'} / {describeEntities(row.actual.candidates) || '无'}</dd></div><div><dt>预期查询 / 实际</dt><dd>{toolNames[row.expected.tool]} / {toolNames[row.actual.tool]}</dd></div><div><dt>预期换件拦截 / 实际</dt><dd>{row.expected.actionBlocked ? '拦截' : '未请求换件'} / {row.actual.actionBlocked ? '拦截' : '未拦截'}</dd></div></dl><ul>{row.checks.map(check => <li key={check.id}>{check.passed ? '符合' : '不符合'} · {check.name}</li>)}</ul><button className="ontology-button" onClick={() => selectScenario(row.id)}>带入这个场景</button></div></details>)}</div><small>验收集 {suite.suiteVersion} · 指纹 {suite.suiteHash.slice(0, 12)}</small></div> : <p className="ob-suite-not-run">尚未执行。这里是自编流程验收，不能替代客服六维 Rubric、真实标注集评测或线上 A/B 实验。</p>}</section>
    <details className="ob-method"><summary>这个演示能证明什么，不能证明什么？</summary><p>{catalog.comparisonMethod}</p><p>本体负责概念与范围；下面的知识条目才提供服务内容。没有知识条目时，即使图上有概念也不会补写答案。</p><div>{catalog.documents.map(document => <article key={document.id}><h4>{document.title}</h4><p>{document.content}</p><small>{document.id}@{document.version} · {document.source}</small></article>)}</div><p>{catalog.boundary} 词典只有有限的否定词处理，不支持任意设备与自由复杂句。下一阶段应在同一模型、同一真实评测集下做开关本体的对照，测量知识适用性、澄清正确率和越权率，再决定是否接入生产。</p></details>
  </section>;
}

function StepEvidence({ step, result, entityLabels }: { step: Step; result: Result; entityLabels: Record<string, string> }) {
  if (step.id === 'normalize') return <div className="ob-mappings"><p>只把实际命中的词写入上下文；缺失内容不补全。</p>{result.context.mappings.map(item => <div key={item.nodeId}><span>{item.terms.join(' / ')}</span><ArrowRight size={15} /><strong>{item.canonical}</strong></div>)}{!result.context.mappings.length && <p>未命中已定义词语，需要澄清。</p>}<p>正文及补充型号：{result.context.modelIds.map(identifier => entityLabels[identifier] || identifier).join('、') || '未提供'}；未知型号：{result.context.unknownModels.join('、') || '无'}；代码：{result.context.codes.join('、') || '未提供'}。</p></div>;
  if (step.id === 'compare') return <div><p>三组使用同一份知识，没有偷偷更换数据源。</p><p>字面检索命中 {result.comparison.literal.length} 条；增加词典归一后命中 {result.comparison.normalized.length} 条。此时仍然只是候选，不是可直接发送给客户的答案。</p><p>如果标准用语本来就能命中，归一不会额外创造收益。可以选择“本来就能命中的对照”核对。</p></div>;
  if (step.id === 'gate') return <div><strong>{result.query.allowed ? '条件满足，允许只读查询' : '条件不足，后续查询未执行'}</strong><p>{result.query.reason}</p><p>{toolNames[result.query.tool]}</p><p>这不是提示词建议：条件不足时，后端不会调用故障知识查询函数。</p></div>;
  if (step.id === 'lookup') return <div className="ob-source-documents"><p>{toolNames[result.query.tool]}。以下仅列实际读取的条目。</p>{result.comparison.selected.map(document => <article key={document.id}><span>证据 · {document.id}@{document.version}</span><h4>{document.title}</h4><p>{document.content}</p><small>{document.source}</small></article>)}{!result.comparison.selected.length && <p>{result.query.allowed ? '查询未找到适用知识，保留缺口并转人工核实。' : '未发起查询，不用示例答案冒充查询结果。'}</p>}</div>;
  if (step.id === 'decision') return <div className="ob-draft"><span>{result.outcome.draft.kind}</span><h4>{result.outcome.title}</h4><p>{result.outcome.actionReason}</p><dl><div><dt>已提供的信息</dt><dd>{result.outcome.draft.facts.length ? result.outcome.draft.facts.map((fact, index) => <span key={index}>{fact.label} · {fact.basis}</span>) : '没有可识别信息'}</dd></div><div><dt>候选，不是结论</dt><dd>{result.outcome.candidateNames.join('、') || '无'}</dd></div><div><dt>知识引用</dt><dd>{result.outcome.draft.references.join('、') || '无'}</dd></div><div><dt>未解决事项</dt><dd>{result.outcome.draft.unknowns.join('；')}</dd></div></dl></div>;
  return <div className="ob-checks"><p>这里只核对输出是否遵守机制，不等同于判断业务答案正确。</p>{result.checks.map(check => <div key={check.id}>{check.passed ? <CheckCircle size={17} /> : <WarningCircle size={17} />}<span>{check.title}</span><strong>{check.passed ? '符合' : '不符合'}</strong></div>)}</div>;
}
