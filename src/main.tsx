import React from 'react';
import ReactDOM from 'react-dom/client';
import '@radix-ui/themes/styles.css';
import SupportApp from './SupportApp';
import { AppearanceProvider } from './appearance';
import './support.css';

class ErrorBoundary extends React.Component<{children:React.ReactNode},{failed:boolean}> {
  state = {failed:false};
  static getDerivedStateFromError() {return {failed:true};}
  render() {return this.state.failed ? <main className="fatal-error"><h1>页面遇到了问题</h1><p>评测数据仍保存在本地。刷新页面后重试。</p><button onClick={()=>location.reload()}>重新加载</button></main>:this.props.children;}
}
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary><AppearanceProvider><SupportApp/></AppearanceProvider></ErrorBoundary></React.StrictMode>);
