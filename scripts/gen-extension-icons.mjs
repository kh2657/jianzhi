// 生成浏览器扩展图标（16/48/128）：圆角方块 + 白色书签丝带。
// 无第三方依赖：手写 PNG 编码（zlib deflate + CRC32），几何按 3×3 超采样抗锯齿。
// 用法：node scripts/gen-extension-icons.mjs（产物提交入库，日常无需重跑）
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons')
const BG = [47, 74, 140] // 深蓝，与工作台 logo 同族的学术蓝
const FG = [255, 255, 255]

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** 单位坐标下的形状覆盖测试：圆角方块背景 + 书签丝带前景 */
function coverage(px, py, size) {
  const x = px / size
  const y = py / size
  const r = 0.22
  const dx = Math.max(r - x, x - (1 - r), 0)
  const dy = Math.max(r - y, y - (1 - r), 0)
  const inPlate = Math.hypot(dx, dy) <= r
  // 书签丝带：竖矩形 (0.34,0.18)-(0.66,0.82)，底部三角缺口 (0.34,0.82)-(0.5,0.64)-(0.66,0.82)
  const inRibbonX = x >= 0.34 && x <= 0.66
  const notchY = 0.64 + Math.abs(x - 0.5) * ((0.82 - 0.64) / 0.16)
  const inRibbon = inRibbonX && y >= 0.18 && y <= Math.max(notchY, 0)
  return inPlate ? (inRibbon ? FG : BG) : null
}

function renderPng(size) {
  const SS = 3
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = coverage(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS, size)
          if (c) {
            r += c[0]
            g += c[1]
            b += c[2]
            a += 255
          }
        }
      }
      const n = SS * SS
      const off = y * (size * 4 + 1) + 1 + x * 4
      raw[off] = Math.round(r / (a / 255 || 1))
      raw[off + 1] = Math.round(g / (a / 255 || 1))
      raw[off + 2] = Math.round(b / (a / 255 || 1))
      raw[off + 3] = Math.round(a / n)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

mkdirSync(OUT_DIR, { recursive: true })
for (const size of [16, 48, 128]) {
  writeFileSync(join(OUT_DIR, `${size}.png`), renderPng(size))
  console.log(`extension/icons/${size}.png 已生成`)
}
