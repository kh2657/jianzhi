#!/usr/bin/env node
/**
 * 按改动选测试（开发循环用）：小改动不必全量回归。
 *
 *   node scripts/affected-tests.mjs                 # 只打印计划（默认）
 *   node scripts/affected-tests.mjs --run           # 计划 + 跑选中的单元用例
 *   node scripts/affected-tests.mjs --run --e2e     # 同时跑选中的 E2E 用例（需先 npm run build）
 *   node scripts/affected-tests.mjs --files a.tsx,b.css   # 手动指定改动（试跑/CI 复用同一逻辑）
 *   node scripts/affected-tests.mjs --json          # 机器可读计划
 *
 * 两条不同的判定路径（**这是要点，不能混用**）：
 *  1. 单元测试：spec 直接 import src 模块，因此用「反向依赖图」精确求解——只跑真正依赖到改动文件的 spec。
 *  2. E2E：spec 只是启动 out/ 里的构建产物，import 图完全看不出关联，所以用**粗粒度特性映射**
 *     （宁多勿少）；改动落在数据内核（repo / folder-store / ipc / preload / shared）时直接判全量。
 *
 * 之所以要这套东西：2026-10 之前的默认做法是「每次改都全量回归」，单测 + E2E 吃掉大部分时间。
 * 但「只跑相关用例」必须防住假信心——所以内核级文件改动一律升级为全量，不允许悄悄少跑。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const valueOf = (name, fallback = null) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const AS_JSON = flag('--json')
const RUN = flag('--run')
const RUN_E2E = flag('--e2e')

/** 改动落在这些文件＝单测必须全量（数据内核：几乎所有 spec 都经过它） */
const FORCE_FULL_UNIT = [
  /^src\/shared\//,
  /^src\/main\/storage\//,
  /^src\/main\/ipc\.ts$/,
  /^src\/preload\//,
  /^tests\/helpers\//,
  /^(package\.json|vitest\.config\.ts|tsconfig.*\.json)$/
]

/** 改动落在这些文件＝E2E 必须全量（每个 E2E 流程都会经过：数据读写、路由入口与全局样式） */
const FORCE_FULL_E2E = [
  /^src\/shared\//,
  /^src\/preload\//,
  /^src\/main\/ipc\.ts$/,
  /^src\/main\/storage\/(repo|folder-store|folder-index|fsutil|section-colors|activity)\.ts$/,
  /^src\/main\/(index|server|assets\/library)\.ts$/,
  /^src\/renderer\/src\/(App|main)\.tsx$/,  // 路由/入口：任一视图都可能被带坏
  /^src\/renderer\/src\/styles\.css$/,       // 全局样式：布局/层级回归可能出现在任何页面
  /^(package\.json|playwright\.config\.ts|electron\.vite\.config\.ts)$/
]

/**
 * 改动路径 → E2E 用例（粗粒度、宁可多跑）。按特性归组而不是按文件归组：
 * 例如「阅读器」这一组包含虚拟滚动、面板、手写、竖向滚动等 spec，改任一相关文件都全跑这一组。
 * 未命中的改动会落到「兜底组」，保证不会出现「改了东西但一个 E2E 都不跑」。
 */
const E2E_GROUPS = {
  library: ['simple-library', 'learning-spaces', 'library-bulk', 'library-diagnostics', 'search-ux', 'fulltext-index'],
  notes: ['footprint', 'note-editor-modes', 'wikilinks', 'note-images-links', 'knowledge-learning', 'note-conflict', 'search-ux'],
  reading: ['simple-reading', 'reading-workspace', 'reading-panel-races', 'material-workspace', 'continuous-scroll', 'ink', 'vertical', 'reader-outline', 'reader-find', 'split-workspace'],
  papers: ['daily-papers', 'papers', 'browser-import'],
  question: ['question-view'],
  shell: ['p1-ux', 'robustness', 'p0-async-error', 'relaunch-flush'],
  capture: ['p0-capture-remark', 'quick-capture', 'compact-workspace'],
  css: ['p0-css-scope']
}
const E2E_MAP = [
  { match: /^src\/renderer\/src\/views\/LibraryView\.tsx$|^src\/renderer\/src\/components\/ContextMenu\.tsx$/, groups: ['library'] },
  { match: /^src\/renderer\/src\/views\/NotesView\.tsx$|^src\/renderer\/src\/views\/NoteEditor\.tsx$|^src\/renderer\/src\/components\/(FootprintPanel|NoteLearningView)\.tsx$|^src\/renderer\/src\/lib\/time-label\.ts$/, groups: ['notes'] },
  { match: /^src\/renderer\/src\/(views\/(ReaderView|HtmlReaderView)\.tsx|components\/(PageSurface|ReadingWorkspacePanel|MaterialNotesPanel|SelPopover)\.tsx)$/, groups: ['reading'] },
  { match: /^src\/renderer\/src\/views\/PapersView\.tsx$/, groups: ['papers'] },
  { match: /^src\/renderer\/src\/views\/InboxView\.tsx$/, groups: ['capture', 'shell'] },
  { match: /^src\/renderer\/src\/views\/TodosView\.tsx$/, groups: ['capture'] },
  { match: /^src\/renderer\/src\/views\/IdeasView\.(tsx|css)$/, groups: ['capture', 'shell'] },
  { match: /^src\/renderer\/src\/components\/ReadingTypography\.tsx$/, groups: ['notes', 'reading', 'capture'] },
  { match: /^src\/renderer\/src\/views\/QuestionView\.tsx$/, groups: ['question'] },
  { match: /^src\/renderer\/src\/components\/QuickCapture\.tsx$/, groups: ['capture'] },
  { match: /^src\/renderer\/src\/components\/(Toast|CommandPalette|SettingsModal|Picker|LoadError|Icon)\.tsx$/, groups: ['shell'] },
  // 保存/加载基础设施：阅读与笔记两侧共用，改动同时影响两边
  { match: /^src\/renderer\/src\/lib\/(async-loader|use-async-data|remark-saver|use-remark-saver)\.ts$/, groups: ['notes', 'reading'] },
  { match: /^src\/renderer\/src\/md\.ts$|^src\/renderer\/src\/lib\/knowledge-blocks\.ts$/, groups: ['notes', 'reading'] },
  { match: /^src\/main\/metadata\//, groups: ['library', 'reading'] },
  { match: /^src\/main\/(papers|papers-daily|browser-import)\.ts$/, groups: ['papers'] },
  { match: /^src\/main\/(menu|logger|url-guard|settings)\.ts$/, groups: ['shell'] },
  { match: /^extension\//, groups: ['papers'] }
]

/** 任何渲染层改动都附带跑的基础冒烟（覆盖面最广、最便宜的一个 spec） */
const E2E_ALWAYS_WITH_RENDERER = 'simple-ui'

// ---------- 改动集合 ----------
function gitLines(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean)
}

/**
 * `git status --porcelain` 的原始行。
 *
 * **不能用 gitLines**：它会 trim 掉行首的状态位空格，于是 `" M path"` 变成 `"M path"`，
 * 再按 `slice(3)` 切路径就会吃掉文件名的首字符（`src/main/...` → `rc/main/...`）。
 * 路径被悄悄改掉后，FORCE_FULL 那类锚定 `^src/...` 的规则全部匹配不上——
 * 这正是这个工具存在的意义（防「子集通过造成假信心」）的反面，必须按原始行解析。
 * `-c core.quotepath=false` 让非 ASCII 路径按 UTF-8 原样输出，而不是 `\345\255...` 转义。
 */
function gitStatusLines() {
  return execFileSync('git', ['-c', 'core.quotepath=false', 'status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean)
}

/**
 * 解析一行 `git status --porcelain` 输出 → 路径；删除或畸形行返回 null。
 *
 * 独立成函数是为了让 --self-test 能直接钉住它：这个解析曾经在行首状态位被 trim 后
 * 按固定偏移切路径，把文件名首字符吃掉（`src/main/...` → `rc/main/...`），
 * 于是所有锚定 `^src/...` 的全量规则静默失效——「防假信心」的工具自己制造假信心。
 */
function parseStatusLine(line) {
  if (typeof line !== 'string' || line.length < 4) return null
  if (line.slice(0, 2).includes('D')) return null // 删除的文件没有可跑的对应物
  let p = line.slice(3)
  if (p.includes(' -> ')) p = p.split(' -> ')[1] // 重命名：取新路径
  return p.replace(/^"|"$/g, '')
}

/** 改动集合：优先 git（工作树 vs HEAD），拿不到就要求显式传 --files（不猜、不静默返回空集） */
function changedFiles() {
  const manual = valueOf('--files')
  if (manual) return manual.split(',').map((s) => s.trim()).filter(Boolean)
  const attempts = [
    () => gitStatusLines().flatMap((line) => {
      const p = parseStatusLine(line)
      return p ? [p] : []
    }),
    () => [...gitLines(['diff', '--name-only', 'HEAD']), ...gitLines(['ls-files', '--others', '--exclude-standard'])]
  ]
  for (const attempt of attempts) {
    try {
      const files = attempt()
      if (files.length) return [...new Set(files)].filter((p) => p && !p.startsWith('.workbuddy/') && !p.startsWith('work/'))
      return []
    } catch (err) {
      lastGitError = err
    }
  }
  console.error('[affected-tests] 无法读取 git 改动集合（本机 git 调用失败）。')
  console.error('  两种解决办法：')
  console.error('  1) 确认 git 可用、工作树干净可读；')
  console.error('  2) 直接指定这次改了哪些文件：node scripts/affected-tests.mjs --files src/renderer/src/views/NotesView.tsx')
  console.error(`  底层错误：${lastGitError?.code ?? lastGitError?.message}`)
  process.exit(2)
}
let lastGitError = null

// ---------- 反向依赖图（仅单元测试用） ----------
const IMPORT_RE = /(?:import|export)[^'"()]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) walk(abs, acc)
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry.name)) acc.push(abs)
  }
  return acc
}

function resolveImport(spec, fromAbs) {
  let base
  if (spec.startsWith('@shared/')) base = join(ROOT, 'src/shared', spec.slice('@shared/'.length))
  else if (spec.startsWith('@renderer/')) base = join(ROOT, 'src/renderer/src', spec.slice('@renderer/'.length))
  else if (spec.startsWith('.')) base = resolve(dirname(fromAbs), spec)
  else return null // 包依赖：不参与图
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, join(base, 'index.ts'), join(base, 'index.tsx')]
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null
}

function buildReverseGraph() {
  const files = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'tests'))]
  const reverse = new Map() // 被依赖文件 → 依赖它的文件集合
  for (const abs of files) {
    let text
    try { text = readFileSync(abs, 'utf8') } catch { continue }
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? m[3]
      if (!spec) continue
      const target = resolveImport(spec, abs)
      if (!target) continue
      if (!reverse.has(target)) reverse.set(target, new Set())
      reverse.get(target).add(abs)
    }
  }
  return reverse
}

function affectedUnitSpecs(changed, reverse) {
  const specs = new Set()
  const queue = changed.map((p) => resolve(ROOT, p)).filter((abs) => existsSync(abs))
  const seen = new Set(queue)
  while (queue.length) {
    const abs = queue.shift()
    if (/^tests\/(?!helpers\/).*\.spec\.ts$/.test(relative(ROOT, abs).replaceAll('\\', '/'))) specs.add(abs)
    for (const dependent of reverse.get(abs) ?? []) {
      if (seen.has(dependent)) continue
      seen.add(dependent)
      queue.push(dependent)
    }
  }
  return [...specs].map((abs) => relative(ROOT, abs).replaceAll('\\', '/')).sort()
}

function affectedE2eSpecs(changed) {
  const available = new Set(readdirSync(join(ROOT, 'tests/e2e'))
    .filter((f) => f.endsWith('.spec.ts'))
    .map((f) => f.replace(/\.spec\.ts$/, '')))
  const picked = new Set()
  const reasons = []
  const rendererTouched = changed.some((p) => p.startsWith('src/renderer/'))
  for (const p of changed) {
    for (const rule of E2E_MAP) {
      if (!rule.match.test(p)) continue
      for (const group of rule.groups) {
        for (const spec of E2E_GROUPS[group] ?? []) if (available.has(spec)) picked.add(spec)
      }
      reasons.push(`${p} → 组 ${rule.groups.join('/')}`)
    }
  }
  if (rendererTouched && available.has(E2E_ALWAYS_WITH_RENDERER)) {
    picked.add(E2E_ALWAYS_WITH_RENDERER)
    reasons.push(`渲染层改动 → 附带 ${E2E_ALWAYS_WITH_RENDERER}（基础冒烟）`)
  }
  return { specs: [...picked].sort(), reasons }
}

// ---------- 主流程 ----------
function buildPlan(changed) {
  const fullUnit = changed.some((p) => FORCE_FULL_UNIT.some((re) => re.test(p)))
  const fullE2e = changed.some((p) => FORCE_FULL_E2E.some((re) => re.test(p)))
  const reverse = buildReverseGraph()
  const unitSpecs = fullUnit ? [] : affectedUnitSpecs(changed, reverse)
  const e2e = fullE2e ? { specs: [], reasons: [] } : affectedE2eSpecs(changed)
  return {
    changed,
    unit: fullUnit
      ? { mode: 'full', reason: changed.filter((p) => FORCE_FULL_UNIT.some((re) => re.test(p))), command: 'npx vitest run' }
      : { mode: unitSpecs.length ? 'subset' : 'none', specs: unitSpecs, command: unitSpecs.length ? `npx vitest run ${unitSpecs.join(' ')}` : null },
    e2e: fullE2e
      ? { mode: 'full', reason: changed.filter((p) => FORCE_FULL_E2E.some((re) => re.test(p))), command: 'npx playwright test' }
      : { mode: e2e.specs.length ? 'subset' : 'none', specs: e2e.specs.map((s) => `tests/e2e/${s}.spec.ts`), reasons: e2e.reasons, command: e2e.specs.length ? `npx playwright test ${e2e.specs.map((s) => `tests/e2e/${s}.spec.ts`).join(' ')}` : null }
  }
}

/**
 * 自检：映射规则本身要能验证（判定逻辑是这个工具唯一的「聪明」部分，不能靠感觉）。
 * 任何机器上都能跑：`node scripts/affected-tests.mjs --self-test`
 */
function runSelfTest() {
  const cases = [
    { name: '渲染层视图（局部改动）', files: ['src/renderer/src/views/LibraryView.tsx'], expect: (p) => p.unit.mode === 'none' && p.e2e.mode === 'subset' && p.e2e.specs.includes('tests/e2e/simple-library.spec.ts') },
    { name: '笔记视图不误命中文献库', files: ['src/renderer/src/views/NotesView.tsx'], expect: (p) => p.e2e.specs.every((s) => s !== 'tests/e2e/simple-library.spec.ts') },
    { name: '有 spec 直接 import 的渲染层模块', files: ['src/renderer/src/lib/remark-saver.ts'], expect: (p) => p.unit.mode === 'subset' && p.unit.specs.includes('tests/remark-saver.spec.ts') },
    { name: '主进程模块（papers-daily）', files: ['src/main/papers-daily.ts'], expect: (p) => p.unit.mode === 'subset' && p.unit.specs.length >= 1 && p.e2e.mode === 'subset' },
    { name: '数据内核 → 单元全量', files: ['src/main/storage/repo.ts'], expect: (p) => p.unit.mode === 'full' },
    { name: '全局样式 → E2E 全量', files: ['src/renderer/src/styles.css'], expect: (p) => p.e2e.mode === 'full' },
    { name: '路由入口 → E2E 全量', files: ['src/renderer/src/App.tsx'], expect: (p) => p.e2e.mode === 'full' },
    { name: '契约类型 → 两边全量', files: ['src/shared/types.ts'], expect: (p) => p.unit.mode === 'full' && p.e2e.mode === 'full' },
    { name: '文档改动 → 不跑测试', files: ['CHANGELOG.md'], expect: (p) => p.unit.mode === 'none' },
    { name: '渲染层改动必须带基础冒烟', files: ['src/renderer/src/components/Toast.tsx'], expect: (p) => p.e2e.specs.includes('tests/e2e/simple-ui.spec.ts') }
  ]
  let failed = 0
  for (const c of cases) {
    const plan = buildPlan(c.files)
    const ok = c.expect(plan)
    if (!ok) failed++
    console.log(`${ok ? '✓' : '✗'} ${c.name}  → 单元 ${plan.unit.mode}${plan.unit.specs?.length ? `(${plan.unit.specs.length})` : ''}；E2E ${plan.e2e.mode}${plan.e2e.specs?.length ? `(${plan.e2e.specs.length})` : ''}`)
  }
  // git status 行解析：回归守卫。曾经把行首状态位的空格 trim 掉再按 slice(3) 切路径，
  // 结果是每个路径都少首字符，`^src/...` 的全量规则全部静默失效。
  const statusCases = [
    [' M src/main/storage/fsutil.ts', 'src/main/storage/fsutil.ts'],
    ['?? tests/e2e/reader-outline.spec.ts', 'tests/e2e/reader-outline.spec.ts'],
    ['A  src/shared/channels.ts', 'src/shared/channels.ts'],
    ['R  old/path.ts -> src/new/path.ts', 'src/new/path.ts'],
    ['D  src/gone.ts', null],
    ['M', null]
  ]
  for (const [line, want] of statusCases) {
    const got = parseStatusLine(line)
    const ok = got === want
    if (!ok) failed++
    console.log(`${ok ? '✓' : '✗'} status 行解析「${line}」→ ${JSON.stringify(got)}（期望 ${JSON.stringify(want)}）`)
  }
  const total = cases.length + statusCases.length
  console.log(failed ? `\n${failed} 项不符预期` : `\n全部 ${total} 项符合预期`)
  process.exit(failed ? 1 : 0)
}

if (flag('--self-test')) runSelfTest()

const changed = changedFiles()
const plan = buildPlan(changed)

if (AS_JSON) {
  console.log(JSON.stringify(plan, null, 2))
} else {
  console.log(`改动 ${changed.length} 个文件：`)
  for (const p of changed.slice(0, 12)) console.log(`  ${p}`)
  if (changed.length > 12) console.log(`  …另有 ${changed.length - 12} 个`)
  console.log('')
  console.log(`单元测试：${plan.unit.mode === 'full' ? '全量（改动触及数据内核）' : plan.unit.mode === 'none' ? '无需运行（无 spec 依赖到这些文件）' : `只跑 ${plan.unit.specs.length} 个相关 spec`}`)
  if (plan.unit.reason?.length) console.log(`  触发全量：${plan.unit.reason.join(', ')}`)
  if (plan.unit.command) console.log(`  ${plan.unit.command}`)
  console.log(`E2E：${plan.e2e.mode === 'full' ? '全量（改动触及共享内核/全局样式）' : plan.e2e.mode === 'none' ? '无需运行（未命中任何特性组）' : `只跑 ${plan.e2e.specs.length} 个相关 spec`}`)
  if (plan.e2e.reason?.length) console.log(`  触发全量：${plan.e2e.reason.join(', ')}`)
  if (plan.e2e.reasons?.length) console.log(`  命中理由：${plan.e2e.reasons.join('；')}`)
  if (plan.e2e.command) console.log(`  ${plan.e2e.command}   # 需先 npm run build`)
}

if (RUN && changed.length) {
  const run = (cmd, cmdArgs) => {
    console.log(`\n$ ${cmd} ${cmdArgs.join(' ')}`)
    execFileSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' })
  }
  if (plan.unit.mode === 'full') run('npx', ['vitest', 'run'])
  else if (plan.unit.specs.length) run('npx', ['vitest', 'run', ...plan.unit.specs])
  else console.log('\n单元测试：跳过（无相关 spec）')

  if (RUN_E2E) {
    if (plan.e2e.mode === 'full') run('npx', ['playwright', 'test'])
    else if (plan.e2e.specs.length) run('npx', ['playwright', 'test', ...plan.e2e.specs])
    else console.log('E2E：跳过（未命中任何特性组）')
  }
}
