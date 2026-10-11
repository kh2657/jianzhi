// 把 PDF.js 运行时资源（CJK cmaps、标准字体、wasm）拷入 renderer public 目录。
// 由 dev/build 脚本自动执行；产物不入库（.gitignore 已排除）。
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const src = join(process.cwd(), 'node_modules/pdfjs-dist')
const dst = join(process.cwd(), 'src/renderer/public/pdfjs')

for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
  const from = join(src, dir)
  if (!existsSync(from)) throw new Error(`缺少 pdfjs-dist/${dir}，请先 npm install`)
}

rmSync(dst, { recursive: true, force: true })
mkdirSync(dst, { recursive: true })
for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
  cpSync(join(src, dir), join(dst, dir), { recursive: true })
}
console.log(`[assets] pdfjs 运行时资源已拷贝到 src/renderer/public/pdfjs`)
