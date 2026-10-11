// Rebuild desktop icon formats from the PNG master used by the application shell.
// Run with Node; Electron supplies the rasterizer, no graphics dependency.
//
// 产出（全部从 resources/logo.png 单一母版推导，换 logo 时只替换母版再跑本脚本）：
//   resources/icon.png    1024 原始尺寸
//   resources/icon.ico    Windows（16–256，7 档）
//   resources/icon.icns   macOS（128/256/512/1024）
//   resources/logo-136.png  应用内显示版（活动栏只显示 34×34；避免启动时传输 1.4MB 母版）
import { _electron as electron } from 'playwright'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'mathwb-icon-'))
const bootstrap = join(scratch, 'render.cjs')
writeFileSync(bootstrap, `const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => { const w = new BrowserWindow({ show: false }); w.loadURL('about:blank'); });`)
const app = await electron.launch({ args: [bootstrap, `--user-data-dir=${join(scratch, 'profile')}`] })
try {
  const page = await app.firstWindow()
  const source = `data:image/png;base64,${readFileSync('resources/logo.png').toString('base64')}`
  const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
  const render = async (size) => page.evaluate(async ({ source, size }) => {
    const image = new Image()
    image.src = source
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = size
    canvas.getContext('2d').drawImage(image, 0, 0, size, size)
    return canvas.toDataURL('image/png').split(',')[1]
  }, { source, size })

  const pngs = new Map()
  for (const size of sizes) {
    pngs.set(size, Buffer.from(await render(size), 'base64'))
  }
  writeFileSync('resources/icon.png', pngs.get(1024))
  const icoSizes = sizes.filter((size) => size <= 256)
  const header = Buffer.alloc(6 + icoSizes.length * 16)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(icoSizes.length, 4)
  let offset = header.length
  icoSizes.forEach((size, index) => {
    const pos = 6 + index * 16
    header[pos] = header[pos + 1] = size === 256 ? 0 : size
    header.writeUInt16LE(1, pos + 4)
    header.writeUInt16LE(32, pos + 6)
    header.writeUInt32LE(pngs.get(size).length, pos + 8)
    header.writeUInt32LE(offset, pos + 12)
    offset += pngs.get(size).length
  })
  writeFileSync('resources/icon.ico', Buffer.concat([header, ...icoSizes.map((s) => pngs.get(s))]))
  const chunks = [[128, 'ic07'], [256, 'ic08'], [512, 'ic09'], [1024, 'ic10']].map(([size, type]) => {
    const h = Buffer.alloc(8)
    h.write(type)
    h.writeUInt32BE(pngs.get(size).length + 8, 4)
    return Buffer.concat([h, pngs.get(size)])
  })
  const icns = Buffer.alloc(8)
  icns.write('icns')
  icns.writeUInt32BE(8 + chunks.reduce((n, c) => n + c.length, 0), 4)
  writeFileSync('resources/icon.icns', Buffer.concat([icns, ...chunks]))
  writeFileSync('resources/logo-136.png', Buffer.from(await render(136), 'base64'))
  console.log('Generated icon.png (1024), icon.ico (7 sizes), icon.icns (4 sizes), logo-136.png from resources/logo.png')
} finally {
  await app.close()
}
