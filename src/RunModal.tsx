import { useEffect, useRef, useState } from 'react';
import { ArrowClockwise, CheckSquare, MagnifyingGlass, Play, Shuffle } from '@phosphor-icons/react';
import { Badge, Button, Modal } from './ui';
import type { Bundle, Case, LabState, Run } from './AgentLab';
import { MAX_RUN_CASES, restrictCasePool, sampleCaseIds } from './caseSampling';

const PAGE_SIZE = 10;

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/support/lab/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '操作未完成');
  return value;
}

export function RunModal({ open, close, bundle, state, parent, submitted, focusJudge = false }: { open: boolean; close: () => void; bundle: Bundle; state: LabState; parent: Run | null; submitted: (run: Run) => Promise<void>; focusJudge?: boolean }) {
  const [cases, setCases] = useState<Case[]>([]);
  const [versions, setVersions] = useState<string[]>([]);
  const [count, setCount] = useState('10');
  const [mode, setMode] = useState<'random' | 'manual'>('random');
  const [randomIds, setRandomIds] = useState<string[]>([]);
  const [manualIds, setManualIds] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [judgeId, setJudgeId] = useState('');
  const [consent, setConsent] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [retry, setRetry] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const options = state.versions.filter(version => version.kind === 'external' || version.bundleId === bundle.id);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setCases([]); setLoadError(''); setError(''); setLoading(true);
    setVersions(parent?.models.map(version => version.id) || []);
    setCount('10'); setMode('random'); setRandomIds([]); setManualIds([]);
    setQuery(''); setSelectedOnly(false); setPage(1);
    setJudgeId(parent?.judgeId || ''); setConsent(false);
    request<Case[]>(`cases?bundle=${encodeURIComponent(bundle.id)}`).then(value => {
      if (!active) return;
      const pool = restrictCasePool(value, parent);
      const initialCount = Math.min(10, pool.length);
      setCases(pool); setCount(String(initialCount));
      setRandomIds(sampleCaseIds(pool.map(item => item.id), initialCount));
    }).catch(problem => {
      if (active) setLoadError(problem instanceof Error ? problem.message : '案例读取失败');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, bundle.id, parent?.id, retry]);

  const manual = mode === 'manual';
  const limit = Math.min(MAX_RUN_CASES, cases.length);
  const countValid = Number.isInteger(Number(count)) && Number(count) >= 1 && Number(count) <= limit;
  const selected = manual ? manualIds : randomIds;
  const selectedCount = selected.length;
  const caseIndex = new Map(cases.map(item => [item.id, item]));
  const search = query.trim().toLocaleLowerCase();
  const visible = manual
    ? cases.filter(item => (!selectedOnly || manualIds.includes(item.id)) && `${item.title} ${item.question || ''} ${item.sessionId} ${item.id} ${state.intents[item.intent] || item.intent}`.toLocaleLowerCase().includes(search))
    : randomIds.flatMap(identifier => caseIndex.has(identifier) ? [caseIndex.get(identifier)!] : []);
  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages);
  const pageCases = visible.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const pageAdditions = pageCases.filter(item => !manualIds.includes(item.id));
  const external = !!judgeId || versions.some(id => options.find(version => version.id === id)?.kind === 'external');
  const destinations = [...new Set(versions.flatMap(id => {
    const version = options.find(value => value.id === id);
    return version?.connectionId ? [state.connections.find(value => value.id === version.connectionId)?.endpoint || '未连接'] : [];
  }).concat(judgeId ? [state.connections.find(value => value.id === judgeId)?.endpoint || '未连接'] : []))];
  const ready = !loading && !loadError && selectedCount > 0 && selectedCount <= limit
    && new Set(selected).size === selectedCount && selected.every(identifier => caseIndex.has(identifier))
    && (manual || (countValid && randomIds.length === Number(count)))
    && versions.length > 0 && versions.length <= 4 && versions.every(identifier => options.some(version => version.id === identifier))
    && (!focusJudge || !!judgeId)
    && (!judgeId || state.connections.some(connection => connection.id === judgeId && connection.configured && connection.tested))
    && (!external || consent);
  const sample = (value: string) => {
    setCount(value); setRandomIds(sampleCaseIds(cases.map(item => item.id), Number(value)));
    setPage(1); setConsent(false);
  };

  return <Modal open={open} onClose={() => !submitting.current && close()} title={parent ? '重跑本批案例' : '新建评测'} description="明确选择模型和案例。每个案例只预测下一轮答复，不等于整段对话的最终解决。" wide>
    <form onSubmit={async event => {
      event.preventDefault();
      if (!ready || submitting.current) return;
      submitting.current = true; setPending(true); setError('');
      try {
        const run = await request<Run>('runs', { bundleId: bundle.id, versionIds: versions, caseIds: selected, parentRunId: parent?.id, judgeId: judgeId || null, consent });
        await submitted(run);
      } catch (problem) { setError(problem instanceof Error ? problem.message : '启动失败'); }
      finally { submitting.current = false; setPending(false); }
    }}>
      <fieldset className="lab-run-fields" disabled={pending}>
        <h3>1. 选择模型版本</h3>
        <div className="lab-version-choices">{options.map(version => <label className="lab-check" key={version.id}>
          <input type="checkbox" checked={versions.includes(version.id)} disabled={!versions.includes(version.id) && versions.length >= 4} onChange={event => { setVersions(values => event.target.checked ? [...values, version.id] : values.filter(value => value !== version.id)); setConsent(false); }} />
          <span>{version.name}<small>{version.provider} · {version.model}</small></span>
        </label>)}</div>
        <section className="lab-case-selection" aria-labelledby="run-case-heading">
          <div className="lab-case-heading"><h3 id="run-case-heading">2. 选择测试案例</h3><span>{parent ? '仅限原批次' : '独立测试集'} · {cases.length} 个可选</span></div>
          <div className="lab-case-modes" role="radiogroup" aria-label="案例选择方式">
            <label className={manual ? '' : 'active'}>
              <input type="radio" name="case-selection-mode" value="random" checked={!manual} onChange={() => { setMode('random'); setPage(1); setConsent(false); }} />
              <Shuffle size={20} /><span><strong>随机抽取</strong><small>按数量抽样，快速测一批</small></span>
            </label>
            <label className={manual ? 'active' : ''}>
              <input type="radio" name="case-selection-mode" value="manual" checked={manual} onChange={() => { setMode('manual'); setPage(1); setConsent(false); }} />
              <CheckSquare size={20} /><span><strong>手动选择</strong><small>搜索并勾选指定案例</small></span>
            </label>
          </div>
          {loading ? <p className="lab-no-data" role="status">正在读取可选案例…</p> : loadError ? <div className="notice error" role="alert">{loadError}<Button onClick={() => setRetry(value => value + 1)}>重试读取</Button></div> : !cases.length ? <p className="lab-no-data" role="status">暂无可用测试案例，请先准备独立测试集。</p> : <>
            {manual ? <>
              <div className="lab-case-tools">
                <div className="search-input"><MagnifyingGlass size={17} /><input aria-label="搜索测试案例" placeholder="搜索问题、案例编号或意图" value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} />{query && <button type="button" aria-label="清除案例搜索" onClick={() => { setQuery(''); setPage(1); }}>清除</button>}</div>
                <label className="lab-check"><input type="checkbox" checked={selectedOnly} onChange={event => { setSelectedOnly(event.target.checked); setPage(1); }} />仅看已选</label>
              </div>
              <div className="lab-case-toolbar"><span>已选 {selectedCount} / {limit} 个{search ? ` · 搜索命中 ${visible.length} 个` : ''}</span><div className="lab-row-actions"><Button disabled={!pageAdditions.length || manualIds.length + pageAdditions.length > limit} onClick={() => { setManualIds(values => [...values, ...pageAdditions.map(item => item.id)]); setConsent(false); }}>选中本页</Button><Button disabled={!manualIds.length} onClick={() => { setManualIds([]); setConsent(false); }}>清空已选</Button></div></div>
            </> : <>
              <div className="lab-case-tools">
                <label className="lab-sample-count">抽取数量<input type="number" aria-label="随机抽取数量" min={1} max={limit} step={1} value={count} aria-invalid={!countValid} aria-describedby="run-sample-hint" onChange={event => sample(event.target.value)} /></label>
                <Button disabled={!countValid || Number(count) === cases.length} onClick={() => sample(count)}><ArrowClockwise size={15} />换一批</Button>
                <span>最多 {limit} 个</span>
              </div>
              <p className={`lab-case-hint ${countValid ? '' : 'invalid'}`} id="run-sample-hint">{!countValid ? `请输入 1–${limit} 的整数。` : selectedCount === cases.length ? '已选全部可用案例，无需换一批。' : '每批内不重复；不同批次可能重合。下方就是本次要运行的案例。'}</p>
            </>}
            <div className="lab-case-list" aria-label={manual ? '可选案例' : '本次抽样预览'}>
              {pageCases.length ? pageCases.map((item, index) => {
                const content = <span className="lab-case-copy"><strong>{item.question || item.title}</strong><small>{item.sessionId} · {state.intents[item.intent] || item.intent}</small></span>;
                return manual ? <label className={`lab-case-row ${manualIds.includes(item.id) ? 'selected' : ''}`} key={item.id} data-case-id={item.id}>
                  <input type="checkbox" aria-label={`选择案例 ${item.id}`} checked={manualIds.includes(item.id)} disabled={!manualIds.includes(item.id) && manualIds.length >= limit} onChange={event => { setManualIds(values => event.target.checked ? [...values, item.id] : values.filter(value => value !== item.id)); setConsent(false); }} />{content}
                </label> : <div className="lab-case-row" key={item.id} data-case-id={item.id}><span className="lab-case-order">{(currentPage - 1) * PAGE_SIZE + index + 1}</span>{content}</div>;
              }) : <p className="lab-no-data">{manual ? selectedOnly ? '没有符合条件的已选案例。取消「仅看已选」或清除搜索后继续选择。' : '没有匹配的案例，请调整搜索。' : '填写有效数量后显示本次抽样。'}</p>}
            </div>
            {pages > 1 && <div className="lab-case-pagination"><span>共 {visible.length} 个 · 第 {currentPage} / {pages} 页</span><div className="lab-row-actions"><Button disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>上一页</Button><Button disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}>下一页</Button></div></div>}
          </>}
          <div className="lab-case-summary" role="status"><Badge tone={selectedCount ? 'blue' : 'gray'}>已选 {selectedCount} 个案例</Badge><span>× {versions.length} 个模型 = {selectedCount * versions.length} 条待评测输出</span><small>所有模型使用同一批案例；选择和预览不调用模型。</small></div>
        </section>
        <details className="lab-disclosure" key={`${parent?.id || 'new'}:${focusJudge}`} open={focusJudge || !!parent?.judgeId || undefined}>
          <summary>模型裁判 · 评审答复质量</summary>
          <label className="form-field">统一裁判<select aria-label="统一模型裁判" value={judgeId} onChange={event => { setJudgeId(event.target.value); setConsent(false); }}><option value="">不使用裁判 · 答复将标为未评审</option>{state.connections.map(connection => <option key={connection.id} value={connection.id} disabled={!connection.configured || !connection.tested}>{connection.name} · {connection.judgeModel} · {connection.configured && connection.tested ? '可用' : '需重新连接并测试'}</option>)}</select></label>
          <p>评审答复是否切题、下一步是否合理、权限与证据边界。需先<a className="text-link" href="#models?connect=1">添加并测试模型连接</a>；同一模型自评可能有偏差。</p>
          {focusJudge && <p className="notice">请明确选择裁判。这会重新生成所选案例的答复并评审，创建新批次；不会给旧回复补写分数或覆盖原记录。</p>}
        </details>
        {!external && <p className="lab-no-data">仅本机执行，不调用外部模型、不产生 API 费用。运行后保留本次案例清单，便于复现；不改变原批次。</p>}
        {external && <div className="lab-consent"><p>发送目的地：{destinations.join('、')}。候选收到历史前缀；裁判另收到原人工参考与候选回复。最多 {selectedCount * (versions.filter(id => options.find(version => version.id === id)?.kind === 'external').length + (judgeId ? versions.length : 0))} 次外部调用；输出上限每次 4096 token，实际费用由服务商收取。</p><label className="lab-check"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />我有权发送本批脱敏数据，确认上述范围与潜在费用。</label></div>}
      </fieldset>
      {error && <div className="notice error" role="alert">{error}</div>}
      <div className="modal-actions"><Button disabled={pending} onClick={close}>取消</Button><Button primary type="submit" disabled={pending || !ready}><Play size={15} />{pending ? '启动中…' : '开始评测'}</Button></div>
    </form>
  </Modal>;
}
