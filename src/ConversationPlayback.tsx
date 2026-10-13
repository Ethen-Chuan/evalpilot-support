import { Fragment } from 'react';
import type { ReactNode } from 'react';
import { ArrowSquareOut, BookOpen, CheckCircle, GitBranch, Headset, Robot, User, Wrench } from '@phosphor-icons/react';
import { Badge, DateText } from './ui';
import './conversation-playback.css';

export type ConversationMessage = { id: string; sequence: number; role: string; content: string; elapsedSeconds?: number; at: string | null; traceId: string | null; turnId: string | null; metadata: { source?: { id: string; title: string; version: number } | null; feedback?: string; handoff?: boolean; method?: string; observedLocally?: boolean } };

const roles: Record<string, string> = { user: '客户', assistant: '智能客服', human: '人工客服', system: '系统记录', tool: '工具记录' };

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const pieces: ReactNode[] = [];
  let cursor = 0;
  let found = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  while (found >= 0) {
    pieces.push(text.slice(cursor, found), <mark key={found}>{text.slice(found, found + query.length)}</mark>);
    cursor = found + query.length;
    found = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase(), cursor);
  }
  pieces.push(text.slice(cursor));
  return <>{pieces}</>;
}

function relativeTime(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `+${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function MessageTime({ message }: { message: ConversationMessage }) {
  if (message.elapsedSeconds !== undefined) return <span title="相对本段会话起点，不是原始绝对时间">相对 {relativeTime(message.elapsedSeconds)}</span>;
  if (message.at) return <DateText value={message.at} />;
  return <span>时间未提供</span>;
}

function Avatar({ role }: { role: string }) {
  const Icon = role === 'user' ? User : role === 'assistant' ? Robot : role === 'human' ? Headset : role === 'tool' ? Wrench : BookOpen;
  return <span className={`chat-avatar avatar-${role}`} aria-hidden="true"><Icon size={22} weight={role === 'user' ? 'fill' : 'regular'} /></span>;
}

function elapsedGap(message: ConversationMessage, previous: ConversationMessage) {
  if (message.elapsedSeconds !== undefined && previous.elapsedSeconds !== undefined) return message.elapsedSeconds - previous.elapsedSeconds;
  if (message.at && previous.at) return (Date.parse(message.at) - Date.parse(previous.at)) / 1000;
  return 0;
}

export function ConversationPlayback({ messages, compact, selectionMode, selected, focusedId, query, onSelect }: { messages: ConversationMessage[]; compact: boolean; selectionMode: boolean; selected: string[]; focusedId: string | null; query: string; onSelect: (identifier: string, checked: boolean) => void }) {
  const selectedIds = new Set(selected);
  const supportRoles = ['assistant', 'human'].filter(role => messages.some(message => message.role === role));
  const customerCount = messages.filter(message => message.role === 'user').length;
  const firstHuman = messages.findIndex(message => message.role === 'human');
  return <section className="conversation-playback" aria-label="微信式对话回放">
    <div className="chat-participants">
      <div className="chat-service-party"><div className="chat-party-avatars">{supportRoles.length ? supportRoles.map(role => <Avatar key={role} role={role} />) : <Avatar role="system" />}</div><div><strong>{supportRoles.length ? '客服' : '会话记录'}</strong><span>{supportRoles.length ? supportRoles.map(role => roles[role]).join(' · ') : '未提供客服发言'}</span></div></div>
      <span className="chat-replay-label">对话回放<small>非实时聊天</small></span>
      <div className="chat-customer-party"><div><strong>客户</strong><span>{customerCount} 条发言 · 已匿名</span></div><Avatar role="user" /></div>
    </div>
    <div className={`dialogue-transcript chat-transcript ${compact ? 'compact' : ''} ${selectionMode ? 'is-selecting' : ''}`} aria-label="完整聊天记录">
      {messages.map((message, index) => {
        const previous = messages[index - 1];
        const gap = previous ? elapsedGap(message, previous) : 0;
        const continued = previous?.role === message.role && gap < 300;
        const showHumanEntry = index === firstHuman && index > 0 && messages.slice(0, index).some(item => item.role === 'assistant');
        return <Fragment key={message.id}>
          {(index === 0 || gap >= 300) && <div className="chat-time-divider">{index === 0 ? '对话开始' : '记录时间'}<span>·</span><MessageTime message={message} /></div>}
          {showHumanEntry && <div className="chat-role-divider"><Headset size={13} />从这里开始出现人工客服回复</div>}
          <article id={`dialogue-message-${message.id}`} data-sequence={message.sequence} aria-label={`第 ${message.sequence} 条 · ${roles[message.role] || message.role}`} className={`dialogue-message chat-message role-${message.role} ${continued ? 'is-continuation' : ''} ${selectedIds.has(message.id) ? 'evidence-selected' : ''} ${focusedId === message.id ? 'focused' : ''}`}>
            <div className="chat-message-row">
              <Avatar role={message.role} />
              <div className="chat-message-main">
                <header className="chat-message-meta">
                  {selectionMode && <label className="chat-message-select"><input type="checkbox" checked={selectedIds.has(message.id)} aria-label={`选择第 ${message.sequence} 条作为知识依据`} onChange={event => onSelect(message.id, event.target.checked)} /></label>}
                  <strong>{roles[message.role] || message.role}</strong>
                  {message.role === 'assistant' && <span className="chat-bot-tag">机器人</span>}
                  <span className="chat-message-number" title={`原始消息序号 ${message.sequence}`}>#{String(message.sequence).padStart(3, '0')}</span>
                  <span className="chat-message-time"><MessageTime message={message} /></span>
                </header>
                <div className="chat-bubble"><div className="dialogue-message-content"><Highlight text={message.content} query={query} /></div></div>
                <footer className="chat-message-evidence">
                  {message.metadata.source && <span><BookOpen size={12} />{message.metadata.source.title} · v{message.metadata.source.version}</span>}
                  {message.metadata.feedback === 'negative' && <Badge tone="amber">用户负反馈</Badge>}
                  {message.traceId && <button className="text-link" onClick={() => window.dispatchEvent(new CustomEvent('evalpilot:trace', { detail: message.traceId }))}><GitBranch size={13} />本轮 Trace <ArrowSquareOut size={12} /></button>}
                </footer>
              </div>
            </div>
          </article>
        </Fragment>;
      })}
      <div className="dialogue-end chat-end"><CheckCircle size={15} /><span>已展示全部 {messages.length} 条消息<small>保留原始顺序 · 没有省略中间轮次</small></span></div>
    </div>
  </section>;
}
