import React from 'react';
import ReactDOM from 'react-dom/client';
import '@radix-ui/themes/styles.css';
import { AppearanceProvider } from './appearance';
import PublicApp from './PublicApp';
import './support.css';

class PublicErrorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <main className="fatal-error"><h1>页面暂时无法加载</h1><p>公开体验版不会连接你的本机数据。请刷新重试。</p><button onClick={() => location.reload()}>重新加载</button></main> : this.props.children; }
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><PublicErrorBoundary><AppearanceProvider><PublicApp /></AppearanceProvider></PublicErrorBoundary></React.StrictMode>);
