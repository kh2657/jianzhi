#!/usr/bin/env node
/**
 * 开发模式（隔离数据目录）。
 *
 * `npm run dev` 与正式版共用 <userData>（macOS: ~/Library/Application Support/数学学习工作台），
 * 好处是能直接拿真实库调试，代价是开发中的 bug 会写进真实库。这个入口改用仓库内的
 * `.dev-data/`（已 gitignore），随便折腾；真实库不受影响。
 *
 * 为什么不用 `electron-vite dev -- --user-data-dir=.dev-data`：
 * app.setPath('userData', …) 要求**绝对路径**，相对路径会让应用启动即抛
 * 「Error: Path must be absolute」（目录建出来了、窗口却没起，很容易看漏）。
 * 这里拼好绝对路径再透传——electron-vite 会把 `--` 之后的参数经 ELECTRON_CLI_ARGS 交给 electron。
 */
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = join(ROOT, '.dev-data')
const isWin = process.platform === 'win32'

const run = (cmd, args) =>
  spawn(isWin ? `${cmd}.cmd` : cmd, args, { cwd: ROOT, stdio: 'inherit' })

console.log(`\n隔离数据目录：${DATA_DIR}\n（真实库不受影响；删掉这个目录即回到全新状态）\n`)

// 先跑 assets:pdfjs（dev 与 build 都依赖 pdfjs 运行时资源），再起 dev
const assets = run('npm', ['run', 'assets:pdfjs'])
assets.on('exit', (code) => {
  if (code !== 0) process.exit(code ?? 1)
  const dev = run('npx', ['electron-vite', 'dev', '--', `--user-data-dir=${DATA_DIR}`])
  dev.on('exit', (c) => process.exit(c ?? 0))
})
