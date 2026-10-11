// 生成可再分发的测试夹具（计划 §3/P0）：
//   text-basic.pdf   文本型 3 页，第 1 页含已知矩形区域 [72,310,520,440] 内的定理文本
//   scanned.pdf      无文本层 2 页（整页位图，位图内绘制了已知区域）
//   rotated-90.pdf   /Rotate 90 的 1 页
//   cropped.pdf      CropBox ≠ MediaBox（页面原点非 (0,0)）的 1 页
//   corrupt.pdf      截断的 PDF（头合法、结构损坏）
//   photo.png/.jpg/.heic  演草纸照片模拟
//   manifest.json    期望值（page.view、页数、旋转、目标矩形）
// 运行：node scripts/gen-fixtures.ts （Node ≥ 23 直接执行 TS）
import { deflateSync } from 'node:zlib'
import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { PDFArray, PDFDocument, PDFHexString, StandardFonts, degrees, rgb, PDFName, PDFString, type PDFPage } from 'pdf-lib'

const run = promisify(execFile)
const OUT = join(process.cwd(), 'fixtures')
mkdirSync(OUT, { recursive: true })

const PAGE_W = 612
const PAGE_H = 792
/** 所有 PDF 夹具共用的已知目标区域（PDF 用户空间） */
const TARGET: [number, number, number, number] = [72, 310, 520, 440]

// ---------- 最小 PNG 编码器（8-bit truecolor） ----------
let crcTable: number[] | null = null
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = []
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1
      crcTable[n] = c
    }
  }
  let crc = 0xffffffff
  for (const b of buf) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const t = Buffer.from(type, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([len, t, data, crc])
}
function makePng(w: number, h: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const stride = w * 3 + 1
  const raw = Buffer.alloc(stride * h)
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixel(x, y)
      const o = y * stride + 1 + x * 3
      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

// ---------- 共用内容 ----------
async function drawTextPage(pdf: PDFDocument, index: number, total: number): Promise<void> {
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const page = pdf.addPage([PAGE_W, PAGE_H])
  page.drawText('Fixture Text Book', { x: 72, y: 726, size: 16, font: fontBold, color: rgb(0.12, 0.13, 0.16) })
  page.drawText(`Chapter ${index + 1}. Continuous Functions`, { x: 72, y: 700, size: 11, font, color: rgb(0.35, 0.36, 0.4) })
  // 已知目标区域（断言用）
  page.drawRectangle({
    x: TARGET[0],
    y: TARGET[1],
    width: TARGET[2] - TARGET[0],
    height: TARGET[3] - TARGET[1],
    borderColor: rgb(0.78, 0.25, 0.25),
    borderWidth: 1.4
  })
  page.drawText(`THEOREM ${String.fromCharCode(65 + index)}.${index + 1} (fixture)`, {
    x: TARGET[0] + 12,
    y: TARGET[3] - 26,
    size: 12.5,
    font: fontBold
  })
  page.drawText('Let f be continuous on [a, b] and differentiable on (a, b).', {
    x: TARGET[0] + 12,
    y: TARGET[3] - 48,
    size: 10.5,
    font
  })
  page.drawText('Then there exists c in (a, b) such that f(b) - f(a) = f(c) (b - a).', {
    x: TARGET[0] + 12,
    y: TARGET[3] - 66,
    size: 10.5,
    font
  })
  page.drawText('Proof. Apply the extreme value theorem and Rolle theorem.', {
    x: TARGET[0] + 12,
    y: TARGET[3] - 88,
    size: 10.5,
    font
  })
  page.drawText(`physical page ${index + 1} / ${total}`, { x: 72, y: 56, size: 9, font, color: rgb(0.5, 0.5, 0.55) })
}

// ---------- 1. text-basic ----------
{
  const pdf = await PDFDocument.create()
  for (let i = 0; i < 3; i++) await drawTextPage(pdf, i, 3)
  writeFileSync(join(OUT, 'text-basic.pdf'), await pdf.save())
}

// ---------- 2. scanned（整页位图、无文本层） ----------
{
  // 位图内绘制目标区域（PDF y 向上 → 像素 y 向下翻转）
  const png = makePng(PAGE_W, PAGE_H, (x, y) => {
    const inRect = x >= TARGET[0] && x <= TARGET[2] && y >= PAGE_H - TARGET[3] && y <= PAGE_H - TARGET[1]
    if (inRect) {
      const band = (y - (PAGE_H - TARGET[3])) | 0
      if (band < 4 || band > TARGET[3] - TARGET[1] - 4) return [120, 40, 40]
      return [252, 250, 244]
    }
    const noise = ((x * 31 + y * 17) % 13) - 6
    const base = 214 + noise
    return [base, base + 1, base - 1]
  })
  const pdf = await PDFDocument.create()
  const img = await pdf.embedPng(png)
  for (let i = 0; i < 2; i++) {
    const page = pdf.addPage([PAGE_W, PAGE_H])
    page.drawImage(img, { x: 0, y: 0, width: PAGE_W, height: PAGE_H })
  }
  writeFileSync(join(OUT, 'scanned.pdf'), await pdf.save())
}

// ---------- 3. rotated-90 ----------
{
  const pdf = await PDFDocument.create()
  await drawTextPage(pdf, 0, 1)
  pdf.getPage(0).setRotation(degrees(90))
  writeFileSync(join(OUT, 'rotated-90.pdf'), await pdf.save())
}

// ---------- 4. cropped（CropBox 偏移） ----------
{
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const page = pdf.addPage([PAGE_W, PAGE_H])
  page.setCropBox(54, 72, 504, 648) // page.view = [54, 72, 558, 720]
  page.drawRectangle({
    x: TARGET[0],
    y: TARGET[1],
    width: TARGET[2] - TARGET[0],
    height: TARGET[3] - TARGET[1],
    borderColor: rgb(0.78, 0.25, 0.25),
    borderWidth: 1.4
  })
  page.drawText('THEOREM C.1 (cropped fixture)', { x: TARGET[0] + 12, y: TARGET[3] - 26, size: 12.5, font })
  page.drawText('page.view = [54, 72, 558, 720]', { x: 80, y: 120, size: 10, font, color: rgb(0.4, 0.4, 0.45) })
  writeFileSync(join(OUT, 'cropped.pdf'), await pdf.save())
}

// ---------- 5. corrupt ----------
{
  const { readFileSync } = await import('node:fs')
  const full = readFileSync(join(OUT, 'text-basic.pdf'))
  writeFileSync(join(OUT, 'corrupt.pdf'), full.subarray(0, 1800))
}

// ---------- 6. 照片（png 原生 + sips 生成 jpg/heic） ----------
{
  const w = 300
  const h = 400
  const png = makePng(w, h, (x, y) => {
    const r = Math.round(40 + (x / w) * 120)
    const g = Math.round(80 + (y / h) * 90)
    const b = Math.round(150 - (x / w) * 60)
    return [r, g, b]
  })
  writeFileSync(join(OUT, 'photo.png'), png)
  // jpg/heic 派生夹具依赖 macOS sips；其他平台只生成 png（影响 HEIC 相关用例，跨平台用例不受影响）
  if (process.platform === 'darwin') {
    await run('/usr/bin/sips', ['-s', 'format', 'jpeg', join(OUT, 'photo.png'), '--out', join(OUT, 'photo.jpg')])
    await run('/usr/bin/sips', ['-s', 'format', 'heic', join(OUT, 'photo.png'), '--out', join(OUT, 'photo.heic')])
  } else {
    console.log('[fixtures] 非 macOS：跳过 photo.jpg / photo.heic（需要 sips）')
  }
}

// ---------- 7. links（链接注释：内跳 + 外部 URI） ----------
{
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const p1 = pdf.addPage([PAGE_W, PAGE_H])
  const p2 = pdf.addPage([PAGE_W, PAGE_H])
  p1.drawText('Fixture Links Paper', { x: 72, y: 726, size: 16, font: fontBold })
  p1.drawText('THEOREM L.1 (fixture links page)', { x: 72, y: 680, size: 12.5, font: fontBold })
  p1.drawText('References', { x: 72, y: 646, size: 12, font: fontBold })
  p1.drawText('[1] Jump to page 2 (internal)', { x: 72, y: 616, size: 11, font })
  p1.drawText('[2] arXiv home (external)', { x: 72, y: 596, size: 11, font })
  p2.drawText('physical page 2 (internal link target)', { x: 72, y: 700, size: 12, font })

  // 低级 API 手写 Link 注释（pdf-lib 无高层链接 API）；同一页多条注释先收集再一次性挂上
  const addAnnot = (
    page: PDFPage,
    rect: [number, number, number, number],
    fields: Record<string, unknown>,
    bucket: ReturnType<typeof PDFArray.withContext>
  ): void => {
    const dict = pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: rect, Border: [0, 0, 0], ...fields })
    bucket.push(pdf.context.register(dict))
  }
  const p1Annots = PDFArray.withContext(pdf.context)
  // 内跳：/Dest [目标页ref /XYZ 0 792 null]
  addAnnot(p1, [70, 612, 320, 630], { Dest: [p2.ref, PDFName.of('XYZ'), 0, 792, null] }, p1Annots)
  // 外部：/A << /S /URI /URI … >>
  addAnnot(p1, [70, 592, 290, 610], { A: { S: 'URI', URI: PDFString.of('https://arxiv.org/') } }, p1Annots)
  p1.node.set(PDFName.of('Annots'), p1Annots)

  // 大纲（目录面板的夹具）：pdf-lib 无高层 API，同样走低级 API 手搭。
  // 结构是双向链表：父 /First /Last，兄弟 /Prev /Next —— 所以先占 ref 再 assign。
  // 标题必须用 PDFHexString.fromText（UTF-16BE + BOM）：PDFString 只按单字节写，
  // 中文会被截断成乱码（pdf.js 读出来是一串 Latin-1 杂字符）。
  const outlinesRef = pdf.context.nextRef()
  const item1Ref = pdf.context.nextRef()
  const item2Ref = pdf.context.nextRef()
  pdf.context.assign(outlinesRef, pdf.context.obj({ Type: 'Outlines', First: item1Ref, Last: item2Ref, Count: 2 }))
  pdf.context.assign(
    item1Ref,
    pdf.context.obj({
      Title: PDFHexString.fromText('第一节 引言'),
      Parent: outlinesRef,
      Dest: [p1.ref, PDFName.of('XYZ'), 0, 792, null],
      Next: item2Ref
    })
  )
  pdf.context.assign(
    item2Ref,
    pdf.context.obj({
      Title: PDFHexString.fromText('第二节 方法'),
      Parent: outlinesRef,
      Dest: [p2.ref, PDFName.of('XYZ'), 0, 792, null],
      Prev: item1Ref
    })
  )
  pdf.catalog.set(PDFName.of('Outlines'), outlinesRef)

  writeFileSync(join(OUT, 'links.pdf'), await pdf.save())
}

// ---------- manifest ----------
const manifest = {
  generatedAt: new Date().toISOString(),
  pageW: PAGE_W,
  pageH: PAGE_H,
  targetRect: TARGET,
  fixtures: {
    'text-basic': { file: 'text-basic.pdf', pages: 3, pageView: [0, 0, PAGE_W, PAGE_H], rotate: 0, hasText: true },
    scanned: { file: 'scanned.pdf', pages: 2, pageView: [0, 0, PAGE_W, PAGE_H], rotate: 0, hasText: false },
    'rotated-90': { file: 'rotated-90.pdf', pages: 1, pageView: [0, 0, PAGE_W, PAGE_H], rotate: 90, hasText: true },
    cropped: { file: 'cropped.pdf', pages: 1, pageView: [54, 72, 558, 720], rotate: 0, hasText: true },
    links: { file: 'links.pdf', pages: 2, pageView: [0, 0, PAGE_W, PAGE_H], rotate: 0, hasText: true }
  } as Record<string, { file: string; pages: number; pageView: number[]; rotate: number; hasText: boolean }>
}
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log('[fixtures] 已生成到', OUT)
