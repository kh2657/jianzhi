#!/usr/bin/env node
/**
 * 安装仓库本地 git hook：把 core.hooksPath 指到 .githooks（版本化、可评审，优于 .git/hooks 里手放脚本）。
 *
 *   node scripts/install-hooks.mjs      # 或 npm run hooks:install
 *
 * 通过 package.json 的 `prepare` 在 npm install 之后自动尝试一次，因此**两台机器各自 npm install 即可**，
 * 不需要手动同步 .git 目录。任何失败都只提示、不报错退出——不能在别人 clone 出来做别的事时把安装打断。
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HOOKS_DIR = '.githooks'

/** 静默模式：npm install 触发的 prepare 不该刷屏 */
const quiet = process.argv.includes('--quiet')

function say(msg) {
  if (!quiet) console.log(msg)
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

try {
  if (!existsSync(join(ROOT, '.git'))) {
    say('[hooks] 不是 git 工作树，跳过')
    process.exit(0)
  }
  if (!existsSync(join(ROOT, HOOKS_DIR, 'pre-push'))) {
    say(`[hooks] 缺少 ${HOOKS_DIR}/pre-push，跳过`)
    process.exit(0)
  }
  // 可执行位缺失时 git 会静默忽略钩子（曾整道门禁未生效），安装时兜底补齐
  try {
    chmodSync(join(ROOT, HOOKS_DIR, 'pre-push'), 0o755)
  } catch {}
  const current = git(['config', '--local', 'core.hooksPath']) || ''
  if (current === HOOKS_DIR) {
    say(`[hooks] 已安装（core.hooksPath=${HOOKS_DIR}）`)
    process.exit(0)
  }
  git(['config', '--local', 'core.hooksPath', HOOKS_DIR])
  say(`[hooks] 已安装：core.hooksPath ${current || '(未设置)'} → ${HOOKS_DIR}`)
  say('[hooks] pre-push 会在 push 前跑 typecheck + 全部单测；跳过用 MATHWB_SKIP_HOOKS=1 git push')
} catch (err) {
  // 常见原因：git 不在 PATH、目录被占用、仓库只读。都不该阻断 npm install。
  say(`[hooks] 未自动安装（${err?.code ?? err?.message}）。需要时手动执行：git config --local core.hooksPath ${HOOKS_DIR}`)
  process.exit(0)
}
