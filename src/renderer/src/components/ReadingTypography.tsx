import { useEffect, useState } from 'react'

/** Screen reading preferences never affect PDF originals or individual math glyphs. */
export function ReadingTypography(): React.ReactElement {
  const [face, setFace] = useState(() => localStorage.getItem('mathwb-reading-face') === 'tex' ? 'tex' : 'times')
  const [size, setSize] = useState(() => {
    const saved = Number(localStorage.getItem('mathwb-reading-size'))
    return [16, 18, 20].includes(saved) ? saved : 16
  })
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--reading-face', `${face === 'tex' ? 'KaTeX_Main' : '"Times New Roman"'}, "Songti SC", "STSong", SimSun, serif`)
    root.style.setProperty('--reading-size', `${size}px`)
    localStorage.setItem('mathwb-reading-face', face)
    localStorage.setItem('mathwb-reading-size', String(size))
  }, [face, size])
  return <details className="reading-typesetting">
    <summary>排版设置</summary>
    <div className="reading-type-options">
      <label>正文字体<select className="input" aria-label="正文字体" value={face} onChange={(e) => setFace(e.target.value)}><option value="times">Times + 宋体</option><option value="tex">TeX 衬线 + 宋体</option></select></label>
      <label>阅读字号<select className="input" aria-label="阅读字号" value={size} onChange={(e) => setSize(Number(e.target.value))}>{[16, 18, 20].map((value) => <option key={value} value={value}>{value} px</option>)}</select></label>
      <span className="muted small">仅调整笔记阅读；投稿排版以期刊模板为准。</span>
    </div>
  </details>
}
