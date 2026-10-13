import { Fragment, useEffect, useRef } from 'react';
import { DownloadSimple, Printer } from '@phosphor-icons/react';
import { Button } from './ui';
import { runUrl } from './labNavigation';
import manual from '../docs/售后客服评测平台_操作说明.md?raw';
import './quick-start.css';

function localLink(target: string) {
  if (!target.startsWith('http://127.0.0.1:4287/#')) return '#guide';
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
    anchor.download = '售后客服评测平台_操作说明.md';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(target), 1000);
  };
  return <article ref={root} className={`quick-start ${compact ? 'compact' : ''}`} onClick={event => { if ((event.target as HTMLElement).closest('a')) onNavigate?.(); }}>
    <header className="guide-header">{!compact && <h1>使用说明</h1>}<p>按顺序体验，不必先学会所有功能。</p><div className="lab-row-actions"><Button onClick={download}><DownloadSimple size={16} />下载说明书</Button>{!compact && <Button onClick={() => window.print()}><Printer size={16} />打印说明</Button>}</div></header>
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
