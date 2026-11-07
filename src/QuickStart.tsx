import { Fragment, useEffect, useRef } from 'react';
import { DownloadSimple, Printer } from '@phosphor-icons/react';
import { Button } from './ui';
import { runUrl } from './labNavigation';
import manual from '../docs/售后客服评测平台_操作说明.md?raw';
import './quick-start.css';

function localLink(target: string) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/#/.test(target)) return '#guide';
  const hash = target.slice(target.indexOf('#'));
  return ['#benchmark', '#overview', '#compare'].includes(hash) ? runUrl(hash.slice(1)) : hash;
}

function inline(text: string) {
  return text.split(/(\[[^\]]+\]\([^)]+\))/g).map((part, index) => {
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    return link ? <a key={index} className="text-link" href={localLink(link[2])}>{link[1]}</a> : <Fragment key={index}>{part}</Fragment>;
  });
}

function paragraphs(body: string) {
  return body.trim().split(/\n\s*\n/).map((block, index) => {
    const lines = block.split('\n');
    if (lines.every(line => /^\d+\. /.test(line))) return <ol key={index}>{lines.map(line => <li key={line}>{inline(line.replace(/^\d+\. /, ''))}</li>)}</ol>;
    if (lines.every(line => line.startsWith('- '))) return <ul key={index}>{lines.map(line => <li key={line}>{inline(line.slice(2))}</li>)}</ul>;
    return <p key={index}>{inline(block)}</p>;
  });
}

const chapters = manual.split('\n## ');
const intro = chapters[0].split('\n').filter(line => !line.startsWith('# ')).join('\n');

export function QuickStart({ compact = false, onNavigate }: { compact?: boolean; onNavigate?: () => void }) {
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    let opened: HTMLDetailsElement[] = [];
    const before = () => { opened = Array.from(root.current?.querySelectorAll<HTMLDetailsElement>('details:not([open])') || []); opened.forEach(element => { element.open = true; }); };
    const after = () => { opened.forEach(element => { element.open = false; }); opened = []; };
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', after);
    return () => { window.removeEventListener('beforeprint', before); window.removeEventListener('afterprint', after); };
  }, []);
  const download = () => {
    const target = URL.createObjectURL(new Blob([manual], { type: 'text/markdown;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = target;
    anchor.download = 'EvalPilot_操作说明.md';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(target), 1000);
  };
  return <article ref={root} className={`quick-start ${compact ? 'compact' : ''}`} onClick={event => { if ((event.target as HTMLElement).closest('a')) onNavigate?.(); }}>
    <header className="guide-header">{!compact && <h1>使用说明</h1>}<p>先走完一项服务，再按需深入本体、模型和数据。</p><div className="lab-row-actions"><a className="text-link" href="/product-prd.html" target="_blank" rel="noreferrer">阅读完整产品 PRD</a><Button onClick={download}><DownloadSimple size={16} />下载原评测工具说明</Button>{!compact && <Button onClick={() => window.print()}><Printer size={16} />打印说明</Button>}</div></header>
    <section className="guide-chapter"><h2>新版：从服务设计到验收发布</h2><ol><li>打开<a className="text-link" href="#service">服务总览</a>，了解服务契约、客户端体验、发布和回流的关系。</li><li>进入<a className="text-link" href="#services?id=screen-care">屏幕异常服务</a>，修改自助入口、适用机型和允许动作，保存草稿。</li><li>在“客户端体验”启动预览，输入“A-100”，再补充“主控板屏幕不亮”。右侧会显示本体归一、真实工具结果和约束依据。</li><li>进入“契约验收”，全部通过后才能发布到本地沙箱。草稿修改不会覆盖发布版本。</li><li>预览中点击“仍需改进”，到<a className="text-link" href="#improve">体验回流</a>审核正确预期，再运行包含此问题的新验收。</li></ol><p>新增客户端预览是确定性本地执行，不调用付费模型，也没有接通真实工单或真人坐席。原<a className="text-link" href="#simulator">对话实验室</a>继续负责 DeepSeek / Qwen 与六维 Rubric；<a className="text-link" href="#ontology">本体图谱</a>保留原有网络、对象卡片、编辑、展开和全屏。</p></section>
    <div className="guide-intro">{paragraphs(intro)}</div>
    {chapters.slice(1).map(chapter => {
      const divider = chapter.indexOf('\n');
      const title = chapter.slice(0, divider);
      const content = paragraphs(chapter.slice(divider + 1));
      return title.startsWith('可选') || title.startsWith('遇到')
        ? <details className="guide-chapter guide-optional" key={title}><summary>{title}</summary>{content}</details>
        : <section className="guide-chapter" key={title}><h2>{title}</h2>{content}</section>;
    })}
  </article>;
}
