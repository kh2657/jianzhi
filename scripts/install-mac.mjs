#!/usr/bin/env node
/**
 * 本地安装：把 /Applications/数学学习工作台.app 换成刚构建的这一份。
 *
 *   npm run install:mac                  # 快速路径：只出 dir，实测约 20 秒（日常更新用）
 *   npm run install:mac:full             # 连 139M 的 zip 一起出（要分发给别人时用，约 25 秒）
 *   npm run install:mac -- --skip-build  # 复用已有 dist 产物，只做替换（约 1 秒）
 *   npm run install:mac -- --quit        # 应用开着时先优雅退出（等同 Cmd+Q，会等落盘完成）
 *
 * 为什么不直接 `npm run dist`：electron-builder.yml 的 mac.target 是 [dir, zip]，
 * 而本地安装只从 dist/mac-arm64/ 复制——那个 zip 是给别人下载的，白花约 15 秒。
 *
 * 替换走「改名备份 → 复制 → 失败回滚」：直接 rm -rf 再 ditto 的话，复制中途失败
 * （磁盘满、权限不足）会留下一个「没有应用」的状态，且旧版已经不可恢复。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP_NAME = '数学学习工作台'
const BUILT_APP = join(ROOT, 'dist/mac-arm64', `${APP_NAME}.app`)
const INSTALLED_APP = `/Applications/${APP_NAME}.app`
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)

function fail(msg) {
  console.error(`\n✗ ${msg}\n`)
  process.exit(1)
}

function run(cmd, cmdArgs, label) {
  const t = Date.now()
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit' })
  if (r.error) fail(`${label} 无法启动：${r.error.message}`)
  if (r.status !== 0) fail(`${label} 失败（退出码 ${r.status}）`)
  console.log(`  ✓ ${label}  ${((Date.now() - t) / 1000).toFixed(1)}s`)
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** 正在运行的、从某个 .app 包里启动的实例（dev 模式从 node_modules 启动，不在此列） */
function runningInstances() {
  const r = spawnSync('pgrep', ['-fl', `${APP_NAME}.app/Contents/MacOS`], { encoding: 'utf8' })
  if (r.status !== 0) return []
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
}

/** 应用在关闭窗口时会等渲染层落盘完成（超时只弹提示、不强杀），所以优雅退出不会丢数据 */
function quitRunningApp() {
  console.log(`  · 应用正在运行，先优雅退出（等同 Cmd+Q）`)
  spawnSync('osascript', ['-e', `tell application "${APP_NAME}" to quit`], { stdio: 'ignore' })
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (runningInstances().length === 0) {
      console.log('  ✓ 已退出')
      return true
    }
    sleepSync(300)
  }
  return false
}

/**
 * 替换 /Applications 里的应用。旧版先改名备份（同卷改名是瞬时的），复制失败就改回来，
 * 因此不存在「复制到一半、旧版也没了」的中间状态。
 */
function replaceApp() {
  if (!existsSync(BUILT_APP)) {
    fail(`没有构建产物：${BUILT_APP}\n  先跑一次完整的 npm run install:mac（去掉 --skip-build）`)
  }
  const backup = `/Applications/.${APP_NAME}.app.bak`
  // backupMade：旧版已改名到 backup（此后 INSTALLED_APP 才是可以动的）
  // copyStarted：ditto 已开始，失败时可能有半成品残留需要清掉
  let backupMade = false
  let copyStarted = false
  try {
    rmSync(backup, { recursive: true, force: true })
    if (existsSync(INSTALLED_APP)) {
      renameSync(INSTALLED_APP, backup)
      backupMade = true
    }
    copyStarted = true
    const t = Date.now()
    const r = spawnSync('ditto', [BUILT_APP, INSTALLED_APP], { stdio: 'inherit' })
    if (r.error) throw r.error
    if (r.status !== 0) throw new Error(`ditto 退出码 ${r.status}`)
    rmSync(backup, { recursive: true, force: true })
    console.log(`  ✓ 替换 /Applications（${backupMade ? '覆盖旧版' : '首次安装'}）  ${((Date.now() - t) / 1000).toFixed(1)}s`)
  } catch (err) {
    // 改名都没成功时不要碰 INSTALLED_APP——那还是用户的应用本体
    if (copyStarted) rmSync(INSTALLED_APP, { recursive: true, force: true })
    if (backupMade && existsSync(backup)) renameSync(backup, INSTALLED_APP)
    fail(`复制到 /Applications 失败（${err.message}），已回滚到替换前的版本（应用保持可用）`)
  }

  // 让 Launchpad / 聚焦立刻认得新装的这份；同时注销 dist 里的构建副本，
  // 避免它被运行过后在启动台多出一个同名图标
  spawnSync(LSREGISTER, ['-f', INSTALLED_APP], { stdio: 'ignore' })
  spawnSync(LSREGISTER, ['-u', BUILT_APP], { stdio: 'ignore' })
}

if (process.platform !== 'darwin') {
  fail(`此脚本只用于 macOS（当前是 ${process.platform}）。Windows 用 npm run update:win`)
}

const started = Date.now()
console.log(`\n安装到 ${INSTALLED_APP}${flag('full') ? '（含 zip，分发用）' : ''}\n`)

const running = runningInstances().filter((line) => line.includes(INSTALLED_APP))
if (running.length) {
  if (!flag('quit')) {
    fail(
      `应用正在运行，替换会得到一个损坏的安装：\n  ${running.join('\n  ')}\n\n` +
        `  先手动退出（Cmd+Q），或改用：npm run install:mac -- --quit`
    )
  }
  if (!quitRunningApp()) {
    fail('等待应用退出超时（可能停在了「保存尚未完成」提示上）。请手动处理后再试')
  }
}

if (flag('skip-build')) {
  console.log('  · 跳过构建与打包，直接替换现有 dist 产物')
} else {
  run('npm', ['run', 'build'], '构建（electron-vite）')
  run(
    'npx',
    ['electron-builder', '--mac', ...(flag('full') ? [] : ['dir'])],
    flag('full') ? '打包（dir + zip）' : '打包（只出 dir）'
  )
}
replaceApp()

console.log(`\n✓ 完成，共 ${((Date.now() - started) / 1000).toFixed(1)}s。启动台 / 聚焦搜「${APP_NAME}」即可打开\n`)
