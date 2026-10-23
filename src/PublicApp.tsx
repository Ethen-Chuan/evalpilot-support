import { useEffect, useState } from 'react';
import { ArrowRight, ArrowsLeftRight, BookOpen, GitBranch, GithubLogo, Moon, ShieldCheck, Sun } from '@phosphor-icons/react';
import { Badge, Button } from './ui';
import { useAppearance } from './appearance';
import { ConversationPlayback } from './ConversationPlayback';
import { DialogueTestWorkbench } from './DialogueTestWorkbench';
import type { ExperienceState } from './ExperienceDashboard';
import { publicExamples, publicCatalog } from './publicExamples';
import './public-site.css';

const repository = 'https://github.com/Ethen-Chuan/evalpilot-support';
const tabs = [{ id: 'cases', label: '案例对照', icon: ArrowsLeftRight }, { id: 'tree', label: '对话测试树', icon: GitBranch }, { id: 'guide', label: '使用与部署', icon: BookOpen }];
const treeState = { projectId: 'public-authored-examples', tree: [], learning: { inventory: { source: 0 } } } as unknown as ExperienceState;

export default function PublicApp() {
  const route = () => tabs.some(tab => tab.id === location.hash.slice(1)) ? location.hash.slice(1) : 'cases';
  const [tab, setTab] = useState(route);
  const [selected, setSelected] = useState(0);
  const [checked, setChecked] = useState<string[]>([]);
  const appearance = useAppearance();
  useEffect(() => { const update = () => setTab(route()); window.addEventListener('hashchange', update); return () => window.removeEventListener('hashchange', update); }, []);
  const example = publicExamples[selected];
  return <div className="public-workspace">
    <aside className="public-sidebar"><a className="public-brand" href="#cases"><span>E</span><div>EvalPilot<small>客服模型评测工作台</small></div></a><span className="public-edition">公开体验版 · 无客户数据</span><nav aria-label="体验导航">{tabs.map(item => <a key={item.id} href={`#${item.id}`} aria-current={tab === item.id ? 'page' : undefined}><item.icon size={18} />{item.label}</a>)}</nav><footer><a href={repository} target="_blank" rel="noreferrer"><GithubLogo size={17} />源码与完整本机版</a><p>无需登录。没有模型接口和密钥输入框，不触发付费调用。</p></footer></aside>
    <main className="public-content"><header className="public-topbar"><span>售后客服 / {tabs.find(item => item.id === tab)?.label}</span><button onClick={() => appearance.update({ mode: appearance.mode === 'light' ? 'dark' : 'light' })} aria-label="切换明暗主题">{appearance.mode === 'light' ? <Moon size={18} /> : <Sun size={18} />}</button></header>
      <div className="public-page"><div className="public-safety"><ShieldCheck size={17} /><p><strong>这是可交互的公开体验，不是云端评测服务。</strong>案例、参考及答复均为人工编写的示例，不是真实客户记录或模型实测。API评测与数据导入请使用本机完整版。</p></div>
      {tab === 'cases' && <><div className="public-heading"><h1>把模型效果，落到一段对话里。</h1><p>同一个客户问题，对照两种答复，核对处理依据。相同标签不代表相同质量。</p></div><div className="public-case-options" role="group" aria-label="选择示例案例">{publicExamples.map((item, index) => <button key={item.sample.id} aria-pressed={selected === index} onClick={() => { setSelected(index); setChecked([]); }}><span>{String(index + 1).padStart(2, '0')}</span>{item.sample.title}</button>)}</div>
      <section className="public-question"><span>用户 · 自建场景</span><ConversationPlayback key={example.sample.id} messages={example.sample.prefix || []} compact selectionMode={false} selected={[]} focusedId={null} query="" onSelect={() => {}} /></section>
      <div className="public-reply-pair">{example.rows.map((row, index) => <article key={example.sample.id + index}><header><h2>示例答复 {index === 0 ? 'A' : 'B'}</h2><Badge>人工编写 · 非模型生成</Badge></header><p className="public-answer">{row.output!.answer}</p><div className="public-review-state"><span>质量状态</span><strong>未评审</strong><small>没有真实裁判调用，不预填分数。</small></div><details className="public-diagnostic"><summary>标签诊断 · 不代表答复质量</summary><dl><div><dt>来源问题分类</dt><dd>{publicCatalog.intents[row.expectedIntent as keyof typeof publicCatalog.intents]}</dd></div><div><dt>示例处理方向</dt><dd>{publicCatalog.actions[row.output!.action as keyof typeof publicCatalog.actions]}</dd></div></dl><p>这里只说明界面的分类含义，没有计算真实模型的匹配率。完整版本可核对来源分类、模型输出与原文。</p></details></article>)}</div>
      <section className="public-checklist"><div><h2>你会重点复核什么？</h2><p>勾选本例的观察点，了解评审思路；不会生成模型得分，切换案例即重置。</p></div><div>{example.checks.map(check => <label key={check}><input type="checkbox" checked={checked.includes(check)} onChange={event => setChecked(values => event.target.checked ? [...values, check] : values.filter(value => value !== check))} />{check}</label>)}</div><small>已勾选 {checked.length} / {example.checks.length} 个观察点</small></section>
      <div className="public-next"><p>还想测试用户中途改口、换设备、连续追问？</p><a href="#tree">设计多轮对话分支<ArrowRight size={16} /></a></div></>}
      {tab === 'tree' && <><div className="public-heading"><h1>让测试覆盖用户的不同走法。</h1><p>下面复用本机版的对话树编辑器。只做设计与本浏览器草稿保存，不调用模型，不向服务器发送输入。请只填写匿名测试内容。</p></div><DialogueTestWorkbench state={treeState} offline /></>}
      {tab === 'guide' && <><div className="public-heading"><h1>体验与真实运行，边界清楚。</h1><p>这个链接适合分享产品思路。完整的模型调用、数据导入与运行记录保留在你的本机工作区。</p></div><section className="public-guide"><h2>在线可以体验</h2><ul><li>切换三个自建售后场景，对照两份不同答复。</li><li>展开诊断说明，区分分类标签与答复质量。</li><li>编辑正常、异常、压力分支，调整测试配比。</li><li>经匿名确认后，将测试树草稿保存在当前浏览器。</li></ul><h2>真实评测请运行完整版本</h2><p>完整源码包含项目集、真实模型连接、同例对比、裁判评审、Trace与复核工作流。需要自行配置本机隐私扫描器，并用已获授权的脱敏数据运行；仓库没有你的客户资料、密钥和历史成绩。</p><pre>git clone {repository}.git{`\ncd evalpilot-support\nnpm ci\nnpm run build\npython3 -m venv .venv\n.venv/bin/python -m pip install -r requirements.txt\nnpm start`}</pre><p>本机版的受保护操作需要兼容DLP扫描器，图像OCR依赖macOS。公网完整服务还需要独立部署后端、登录权限、密钥托管和数据隔离，不能直接公开本机端口。</p><a className="public-primary" href={`${repository}#readme`} target="_blank" rel="noreferrer">查看安装与安全说明<ArrowRight size={16} /></a><h2>线上数据说明</h2><p>这里没有上传、登录、API Key输入或后台推理入口。网络连接策略禁止网页发起API请求；草稿只保存在此域名的浏览器存储，清理浏览器会丢失。不要在草稿中填写真实客户信息或凭证。</p><Button onClick={() => { location.hash = 'cases'; }}>回到案例对照</Button></section></>}
      <footer className="public-footer">EvalPilot · 公开体验版<span>完整运行数据未公开 · 无预设模型成绩</span></footer></div>
    </main>
  </div>;
}
