import { useEffect, useState } from 'react';
import { Badge, Button, Modal } from './ui';
import type { ModelCapability } from './modelReadiness';
import './model-connection.css';

export type Connection = { id: string; name: string; family: string; model: string; judgeModel: string; provider: string; endpoint: string; configured: boolean; tested: boolean; visionTested?: boolean };
type Service = { id: string; name: string; endpoint: string; discovery: boolean; note: string; local?: boolean };
type ModelList = { provider: string; models: string[]; partial: boolean; inferenceTested: boolean };
const vl2Models = ['deepseek-ai/deepseek-vl2', 'deepseek-ai/deepseek-vl2-small', 'deepseek-ai/deepseek-vl2-tiny'];

async function request<Value>(path: string, body?: unknown): Promise<Value> {
  const response = await fetch(`/api/support/lab/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '操作未完成');
  return value;
}

export function ConnectionModal({ open, close, connection, changed, useConnection, suggestedFamily = '', requiredCapability = 'text' }: { open: boolean; close: () => void; connection: Connection | null; changed: () => Promise<void>; useConnection?: (id: string) => void; suggestedFamily?: string; requiredCapability?: ModelCapability }) {
  const [services, setServices] = useState<Service[]>([]);
  const [catalogError, setCatalogError] = useState('');
  const [retry, setRetry] = useState(0);
  const [provider, setProvider] = useState('openai');
  const [endpoint, setEndpoint] = useState('');
  const [name, setName] = useState('');
  const [family, setFamily] = useState('');
  const [model, setModel] = useState('');
  const [judge, setJudge] = useState('');
  const [key, setKey] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [testConsent, setTestConsent] = useState(false);
  const [savedId, setSavedId] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const [tested, setTested] = useState(false);
  const [visionTested, setVisionTested] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [manual, setManual] = useState(false);
  const [listMessage, setListMessage] = useState('');
  const service = services.find(item => item.id === provider);
  const local = service?.local === true;
  const availableModels = models.length ? models : local ? vl2Models : [];
  const destination = local ? endpoint : service?.endpoint || connection?.endpoint || '读取中…';
  const credentialsReady = local ? /^http:\/\/(127\.0\.0\.1|\[::1\]):[1-9][0-9]{3,4}\/v1\/?$/.test(endpoint) : !!key;
  const locked = !!connection || !!savedId;
  const usable = requiredCapability === 'vision' ? visionTested : tested;

  useEffect(() => {
    if (!open) return;
    let active = true;
    setCatalogError('');
    request<Service[]>('services').then(value => { if (active) setServices(value); }).catch(() => { if (active) setCatalogError('服务列表读取失败，请重试。'); });
    return () => { active = false; };
  }, [open, retry]);
  useEffect(() => {
    setKey(''); setName(connection?.name || ''); setFamily(connection?.family || suggestedFamily);
    setModel(connection?.model || ''); setJudge(connection?.judgeModel || ''); setProvider(connection?.provider || 'openai');
    setEndpoint(connection?.endpoint || '');
    setConfirmed(false); setTestConsent(false); setSavedId(connection?.configured ? connection.id : ''); setMessage(''); setFailed(false);
    setTested(!!connection?.configured && connection.tested); setModels([]); setManual(false); setListMessage('');
    setVisionTested(!!connection?.configured && !!connection.visionTested);
  }, [open, connection?.id, suggestedFamily]);

  const dismiss = () => { if (!pending) { setKey(''); close(); } };
  const chooseService = (identifier: string) => {
    const selected = services.find(item => item.id === identifier);
    if (!selected || locked || pending) return;
    setProvider(identifier); setEndpoint(selected.local ? selected.endpoint : ''); setKey(''); setConfirmed(false); setTestConsent(false);
    setModel(identifier === 'deepseek' ? 'deepseek-flash' : identifier === 'deepseek_vl2' ? vl2Models[0] : '');
    setName(identifier === 'deepseek' ? 'DeepSeek Flash' : ''); setFamily(identifier.startsWith('deepseek') ? 'DeepSeek' : suggestedFamily);
    setJudge(''); setModels([]); setManual(false); setListMessage(''); setMessage(''); setFailed(false); setTested(false); setVisionTested(false);
  };
  const discover = async () => {
    if (!service?.discovery || !confirmed || !credentialsReady || pending || locked) return;
    setPending(true); setMessage(''); setListMessage(''); setModels([]); setFailed(false);
    try {
      const result = await request<ModelList>('connections/models', { provider, apiKey: key, confirmed, ...(local ? { endpoint } : {}) });
      setModels(result.models); setManual(!!model && !result.models.includes(model));
      setListMessage(result.models.length ? `读取到 ${result.models.length} 个模型${result.partial ? '（仅当前页，其他模型可手动填写）' : ''}。请选择支持对话的模型，仍须完成连接测试。` : '账号未返回可选模型，可核对权限或手动填写模型 ID。');
    } catch (problem) { setFailed(true); setMessage(problem instanceof Error ? problem.message : '读取失败，可手动填写模型 ID'); }
    finally { setPending(false); }
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!service || pending || !confirmed || !credentialsReady || !model.trim()) return;
    setPending(true); setMessage(''); setFailed(false); setKey(''); setTested(false); setVisionTested(false); setTestConsent(false);
    try {
      const displayName = name.trim() || model.trim().slice(0, 60);
      const saved = await request<Connection>('connections', { name: displayName, family: family.trim() || displayName, provider, candidateModel: model.trim(), judgeModel: judge.trim() || model.trim(), apiKey: key, confirmed, ...(local ? { endpoint } : {}), connectionId: connection?.id || savedId || undefined });
      setName(displayName); setSavedId(saved.id); setMessage('已保存到本地服务内存。请授权连接测试，再选用模型。');
      await changed();
    } catch (problem) { setFailed(true); setMessage(problem instanceof Error ? problem.message : '配置失败，请重新填写密钥'); }
    finally { setPending(false); }
  };
  const test = async (vision: boolean) => {
    if (!savedId || !testConsent || pending) return;
    setPending(true); setVisionTested(false); setMessage(''); setFailed(false);
    if (!vision) setTested(false);
    try {
      const status = await request<{ tested: boolean; visionTested?: boolean }>(vision ? 'connections/test-vision' : 'connections/test', { id: savedId, confirmed: true });
      setTested(status.tested === true); setVisionTested(status.visionTested === true);
      setMessage(vision ? status.visionTested ? '图像读取测试通过。可进入图文评测；这不是业务质量评分。' : '服务没有确认看图测试通过，暂不能用于图文评测。' : requiredCapability === 'vision' ? '文字与 JSON 测试通过，但还不能看作图文可用。请再授权并点击「测试图像读取」。' : '文字与 JSON 测试通过。可选用此模型；客户案例仍需单独授权。');
    } catch (problem) { setFailed(true); setMessage(problem instanceof Error ? problem.message : '连接测试失败'); }
    finally { setTestConsent(false); await changed().catch(() => {}); setPending(false); }
  };

  return <Modal open={open} onClose={dismiss} title={connection ? '管理模型连接' : '接入真实模型'} description="连接官方 API 或你自己的本机推理服务。密钥仅存本机内存，服务重启后需重新连接。">
    <p className="connection-hint">接入后可用于文本模型对比、图文评测和质检裁判。每次评测仍需另行授权；填写 Key 不会自动开始运行，也不代表已接通生产发布或真实客服转接。</p>
    {!locked && <div className="connection-presets" role="group" aria-label="DeepSeek 看图模型快捷配置">
      <button type="button" aria-pressed={provider === 'deepseek' && model === 'deepseek-flash'} disabled={pending || !services.some(item => item.id === 'deepseek')} onClick={() => chooseService('deepseek')}><strong>DeepSeek Flash</strong><span>云端 API · 图文问答</span></button>
      <button type="button" aria-pressed={provider === 'deepseek_vl2'} disabled={pending || !services.some(item => item.id === 'deepseek_vl2')} onClick={() => chooseService('deepseek_vl2')}><strong>DeepSeek-VL2</strong><span>私有部署 · 需已有推理服务</span></button>
    </div>}
    {requiredCapability === 'vision' && <div className="notice">当前用于图文评测，候选与裁判都需通过「测试图像读取」。{savedId ? '连接已保存在本机服务内存中，无需重复填写，直接到下方第 3 步授权验证。' : '请先保存连接，再验证看图能力。'}</div>}
    <form onSubmit={event => void save(event)} className="model-connection-form">
      <fieldset disabled={pending} className="connection-section">
        <legend><span>1</span>服务与授权</legend>
        {catalogError && <div role="alert" className="notice error">{catalogError}<Button onClick={() => setRetry(value => value + 1)}>重试服务列表</Button></div>}
        <label className="form-field">模型服务<select aria-label="模型服务" value={provider} disabled={locked || !services.length} onChange={event => chooseService(event.target.value)}>
          {!services.length && <option value={provider}>正在读取服务列表…</option>}{services.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        {local && <label className="form-field">本机服务地址<input aria-label="本机服务地址" value={endpoint} disabled={locked} onChange={event => { setEndpoint(event.target.value); setKey(''); setConfirmed(false); setModels([]); setListMessage(''); }} placeholder="http://127.0.0.1:8000/v1" autoComplete="off" spellCheck={false} maxLength={100} required /></label>}
        <p className="connection-destination">唯一发送目的地 <code>{destination}</code></p>
        {service?.note && <p className="connection-hint">{service.note}</p>}
        {local && <details className="connection-options"><summary>还没有 VL2 服务？查看连接步骤</summary><ol><li>在具备足够显存的 GPU 服务器部署 VL2 的 OpenAI 兼容服务；可使用支持 VL2 的 vLLM。</li><li>若部署在内网服务器，将其端口通过 SSH 转发到本机，再填上面的回环地址。不要直接暴露公网。</li><li>选择服务实际加载的 VL2 规格（或手填服务别名），保存后测试图像读取。只有测试通过才可选入评测。</li></ol><p>此入口不会下载权重或替你部署 GPU 服务。VL2 使用短上下文图文问答；长对话超限会报错，不会偷偷截断后评分。</p></details>}
        <label className="form-field">API Key{local ? '（私有服务未设鉴权时可留空）' : ''}<input aria-label="API Key" type="password" value={key} onChange={event => { setKey(event.target.value); setModels([]); setListMessage(''); setConfirmed(false); }} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder={savedId ? '已保存；仅更换密钥时重新填写' : local ? '仅填私有服务密钥，不要填 DeepSeek 云端 Key' : '只在这里输入，不在聊天中发送'} required={!local} maxLength={512} /></label>
        <label className="lab-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{local ? '确认连接我部署的上述本机服务；如使用隧道，我已核对它的目标。' : '确认密钥仅用于上述官方服务；'}读取模型列表不会发送客户案例或运行推理。</label>
      </fieldset>
      <fieldset disabled={pending || locked} className="connection-section">
        <legend><span>2</span>选择模型</legend>
        {!locked && service?.discovery && <div className="connection-discover"><Button disabled={!confirmed || !credentialsReady} onClick={() => void discover()}>{local ? '读取已部署模型' : '读取账号模型列表'}</Button><small>{local ? '确认实际服务，不触发下载或推理' : '按你的账号实时读取，不预置排行榜'}</small></div>}
        {listMessage && <p className="connection-hint" role="status">{listMessage}</p>}
        <label className="form-field">候选模型名称{availableModels.length > 0 && !manual && !locked ? <select aria-label="候选模型名称" value={model} required onChange={event => { if (event.target.value === '__manual__') { setManual(true); setModel(''); } else setModel(event.target.value); }}><option value="">选择实际可用的模型</option>{availableModels.map(identifier => <option key={identifier} value={identifier}>{identifier}</option>)}<option value="__manual__">手动填写其他模型 ID…</option></select> : <input aria-label="候选模型名称" value={model} onChange={event => setModel(event.target.value)} placeholder="从服务商控制台复制模型 ID" required maxLength={120} disabled={locked || pending} />}</label>
        {local && !models.length && <p className="connection-hint">上面列出 VL2 的三种规格，仅供填写，不代表本机已安装；必须与推理服务加载的模型一致。</p>}
        {manual && models.length > 0 && !locked && <button type="button" className="text-link" onClick={() => { setManual(false); setModel(''); }}>返回已读取的模型列表</button>}
        <details className="connection-options"><summary>显示名称与裁判设置（可选）</summary>
          <label className="form-field">版本显示名称<input value={name} onChange={event => setName(event.target.value)} placeholder="默认使用模型 ID" maxLength={60} disabled={locked || pending} /></label>
          <label className="form-field">模型系列（仅用于归档）<input value={family} onChange={event => setFamily(event.target.value)} placeholder="不填也可以" maxLength={60} disabled={locked || pending} /></label>
          <label className="form-field">裁判模型名称<input value={judge} onChange={event => setJudge(event.target.value)} placeholder="默认与候选相同；也可在对比页另选裁判" maxLength={120} disabled={locked || pending} /></label>
          <p className="connection-hint">同一模型兼任候选与裁判可能有自评偏差。更换模型请创建新连接，历史记录不会被覆盖。</p>
        </details>
      </fieldset>
      <div className="modal-actions"><Button onClick={dismiss} disabled={pending}>关闭</Button><Button primary type="submit" disabled={pending || !service || !confirmed || !credentialsReady || !model.trim()}>{pending ? '处理中…' : '保存内存配置'}</Button></div>
    </form>
    {savedId && <section className="lab-connection-test connection-section"><h3><span>3</span>验证可用性<Badge tone={tested ? 'green' : 'gray'}>{tested ? '文字已通过' : '文字未验证'}</Badge><Badge tone={visionTested ? 'green' : 'amber'}>{visionTested ? '看图已通过' : '看图未通过'}</Badge></h3>
      <label className="lab-check"><input type="checkbox" disabled={pending} checked={testConsent} onChange={event => setTestConsent(event.target.checked)} />允许本次发送自建文字 / 图片做测试，最多 2 次调用，可能收费；不含客户数据。</label>
      <div className="lab-row-actions"><Button disabled={pending || !testConsent} onClick={() => void test(false)}>测试文字连接</Button><Button primary={requiredCapability === 'vision'} disabled={pending || !testConsent} onClick={() => void test(true)}>测试图像读取</Button></div>
    </section>}
    {message && <div className={`notice ${failed ? 'error' : ''}`} role={failed ? 'alert' : 'status'}>{message}</div>}
    <p className="connection-hint">模型列表不保证 JSON 或图像兼容性，以测试为准。本次接入的是图文问答评测，不是工具执行或 DSH Agent 循环；不会自动退款、派单或连接生产系统。</p>
    {useConnection && <div className="modal-actions"><Button primary disabled={pending || !usable || !savedId} onClick={() => { if (!usable || !savedId || pending) return; useConnection(savedId); dismiss(); }}>完成并选用此模型</Button></div>}
    {!useConnection && usable && savedId && <div className="modal-actions"><a className="text-link" href={requiredCapability === 'vision' ? '#compare?mode=vision' : '#compare?mode=text&panel=setup'} onClick={dismiss}>去选择模型和案例 →</a></div>}
  </Modal>;
}
