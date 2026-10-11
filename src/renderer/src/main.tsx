import React from 'react'
import { createRoot } from 'react-dom/client'
import 'katex/dist/katex.min.css'
import './styles.css'
import { App } from './App'

// pdf.js 销毁加载任务（阅读器卸载/切换文档）时，内部 promise 链会以这几条固定消息
// reject 且无消费者，属于合法取消的固有噪音；吞掉它们，真实的加载错误仍走 toast/错误态。
const PDFJS_TEARDOWN_MESSAGES = new Set(['Worker was terminated', 'Worker was destroyed', 'Loading aborted'])
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason as { message?: string } | undefined
  const message = reason?.message
  if (message !== undefined && PDFJS_TEARDOWN_MESSAGES.has(message)) event.preventDefault()
})

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
