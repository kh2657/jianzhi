import type { CSSProperties } from 'react'

const paths = {
  library: <><rect x="3" y="4" width="5" height="16" rx="1" /><path d="M11 4v16M15 5l4-1 3 15-4 1zM4 16h3" /></>,
  note: <><path d="M14 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-9M9 15l1-4 9-9 3 3-9 9-4 1z" /></>,
  inbox: <><path d="M4 4h16l2 12v4H2v-4L4 4zM2 16h6l2 3h4l2-3h6" /></>,
  papers: <><path d="M6 3h12v18H6zM9 7h6M9 11h6M9 15h3" /></>,
  reader: <><path d="M12 6c-1.8-1.3-4.2-2-8-2v14c3.8 0 6.2.7 8 2 1.8-1.3 4.2-2 8-2V4c-3.8 0-6.2.7-8 2z" /><path d="M12 6v14" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  // 研究问题：问号——与「待办=勾」「笔记=纸」区分明显，1.8px 线条与整套一致
  question: <><path d="M9.2 9a2.9 2.9 0 1 1 4 2.7c-.8.4-1.2 1-1.2 1.9v.4" /><path d="M12 17.4h.01" /></>,
  folder: <path d="M3 7V5h7l2 2h9v13H3V7z" />,
  sidebar: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>,
  moon: <path d="M20.5 14A8.5 8.5 0 0 1 10 3.5 8.5 8.5 0 1 0 20.5 14Z" />,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></>,
  star: <path d="M12 3l2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L4.2 9.4l6.1-.9z" />,
  edit: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></>,
  trash: <><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v6M14 11v6" /></>,
  more: <><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></>,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  // 阅读器工具条与批注工具条：与既有 1.8px 线条体系一致，替代此前的文本字形（◀ ▶ − ＋ ↻ ◻ ↩）
  pagePrev: <path d="M15 5l-7 7 7 7" />,
  pageNext: <path d="M9 5l7 7-7 7" />,
  zoomIn: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /><path d="M10.5 7.8v5.4M7.8 10.5h5.4" /></>,
  zoomOut: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /><path d="M7.8 10.5h5.4" /></>,
  rotate: <><path d="M20 12a8 8 0 1 1-2.3-5.65" /><path d="M18.6 3.2v3.6h-3.6" /></>,
  undo: <><path d="M9 14 4 9l5-5" /><path d="M4 9h9a6 6 0 0 1 0 12h-2" /></>,
  eraser: <><path d="M7 20h13" /><path d="M10.5 20 5 14.5 14.5 5l5.5 5.5L10.5 20Z" /></>
}

export function Icon({ name, size = 18, style }: { name: keyof typeof paths; size?: number; style?: CSSProperties }): React.ReactElement {
  return <svg className="ui-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>{paths[name]}</svg>
}
