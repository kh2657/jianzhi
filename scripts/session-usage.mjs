#!/usr/bin/env node
/**
 * 会话用量分析（开发循环用）：把一个 agent 会话的 token 账算清楚。
 *
 *   node scripts/session-usage.mjs                    # 当前项目（按 cwd 匹配）的全部会话
 *   node scripts/session-usage.mjs --all              # 所有项目的会话
 *   node scripts/session-usage.mjs --file <x.jsonl>   # 指定单个 transcript
 *   node scripts/session-usage.mjs --json             # 机器可读
 *   node scripts/session-usage.mjs --weights 1,1.25,0.1,5   # 计费倍率：新输入,缓存写,缓存读,输出
 *
 * 为什么要有这个：agent 会话的「花费」和「实际吞吐」常常差两个数量级。实测一个跑了 2h40m 的会话，
 * 面板上只记 1.04M 新输入，但真实流过模型的是 2.2 亿 token——其中 99.5% 命中了 prompt cache，
 * 按约 1/10 计费。只看面板数字会得出「跑得少」的错误结论，而真正的成本引擎是**上下文大小 × 轮次**。
 * 这个脚本把两类数字分开算，并给出上下文增长曲线。
 *
 * 用途不止于算账：换模型、换 harness（opencode 等）时，用同一组硬指标对照，
 * 比「我觉得哪个好」可靠得多。核心可比指标是：缓存命中率、每轮平均上下文、工具调用有效率。
 *
 * 数据来源：Claude Code 的 transcript（<home>/.claude/projects/<slug>/*.jsonl）。
 * 每轮 assistant 消息里带 usage{input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens}。
 * 接别的 agent 在 PARSERS 里加一个解析器即可——只要产出同样的 usage 四元组与时间戳。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const valueOf = (name, fallback = null) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const AS_JSON = flag('--json')
const ALL_PROJECTS = flag('--all')
const ONLY_FILE = valueOf('--file')
const CWD = resolve(valueOf('--cwd', process.cwd()))
const WEIGHTS = (valueOf('--weights', '1,1.25,0.1,5') || '').split(',').map(Number)
const PROJECTS_DIR = join(homedir(), '.claude', 'projects')

/** 缓存命中率 = 缓存读 / 全部输入侧 token。低于 90% 说明前缀不稳定，缓存没吃满。 */
const hitRate = (s) => {
  const total = s.input + s.cacheWrite + s.cacheRead
  return total === 0 ? 0 : s.cacheRead / total
}

/** 计费等效输入：把三类输入按倍率折算成一个可比的数。倍率随 provider 而异，务必按实际价格覆盖。 */
const billable = (s) => s.input * WEIGHTS[0] + s.cacheWrite * WEIGHTS[1] + s.cacheRead * WEIGHTS[2] + s.output * WEIGHTS[3]

const n = (x) => x.toLocaleString('en-US')
const pct = (x) => `${(x * 100).toFixed(1)}%`

function humanDuration(ms) {
  const m = Math.round(ms / 60000)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

function stamp(iso) {
  if (!iso) return '?'
  const d = new Date(iso)
  const p = (x) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 用块字符画上下文增长曲线——比数字更快看出「它在什么时候胖起来的」。 */
function sparkline(values, buckets = 48) {
  if (values.length === 0) return ''
  const marks = '▁▂▃▄▅▆▇█'
  const max = Math.max(...values)
  if (max === 0) return marks[0].repeat(buckets)
  const step = values.length / buckets
  let out = ''
  for (let i = 0; i < buckets; i++) {
    const slice = values.slice(Math.floor(i * step), Math.max(Math.floor((i + 1) * step), Math.floor(i * step) + 1))
    if (slice.length === 0) continue
    const avg = slice.reduce((a, b) => a + b, 0) / slice.length
    out += marks[Math.min(marks.length - 1, Math.floor((avg / max) * marks.length))]
  }
  return out
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  for (const c of content) {
    if (c && c.type === 'text' && typeof c.text === 'string') return c.text
  }
  return ''
}

/**
 * Claude Code transcript 解析器。
 * 逐行 JSON；我们只关心四类行：summary（标题）、user（首条拿标题）、assistant（usage 与工具调用）。
 */
function parseClaudeCode(file) {
  const s = {
    file,
    cwd: null,
    model: null,
    title: null,
    turns: 0,
    sidechainTurns: 0,
    input: 0,
    cacheWrite: 0,
    cacheRead: 0,
    output: 0,
    toolCalls: 0,
    tools: new Map(),
    firstTs: null,
    lastTs: null,
    contexts: [],
  }

  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let d
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }

    if (!s.cwd && typeof d.cwd === 'string') s.cwd = d.cwd
    if (typeof d.timestamp === 'string') {
      if (!s.firstTs) s.firstTs = d.timestamp
      s.lastTs = d.timestamp
    }
    if (d.type === 'summary' && typeof d.summary === 'string') s.title ||= d.summary
    if (d.type === 'user' && !s.title) {
      const t = textOf(d.message?.content)
      if (t) s.title = t.slice(0, 40).replace(/\s+/g, ' ')
    }

    const msg = d.message
    if (d.type !== 'assistant' || !msg || typeof msg !== 'object') continue
    if (msg.model) s.model = msg.model

    const u = msg.usage
    if (u) {
      if (d.isSidechain) s.sidechainTurns++
      else s.turns++
      s.input += u.input_tokens || 0
      s.cacheWrite += u.cache_creation_input_tokens || 0
      s.cacheRead += u.cache_read_input_tokens || 0
      s.output += u.output_tokens || 0
      s.contexts.push((u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0))
    }

    if (Array.isArray(msg.content)) {
      for (const c of msg.content) {
        if (c && c.type === 'tool_use' && c.name) {
          s.toolCalls++
          s.tools.set(c.name, (s.tools.get(c.name) || 0) + 1)
        }
      }
    }
  }

  return s.turns > 0 || s.toolCalls > 0 ? s : null
}

/** 接别的 agent（opencode 等）时在这里注册。只要产出与 parseClaudeCode 相同的结构即可。 */
const PARSERS = [parseClaudeCode]

function parse(file) {
  for (const p of PARSERS) {
    try {
      const r = p(file)
      if (r) return r
    } catch {
      /* 换下一个解析器 */
    }
  }
  return null
}

function collectFiles() {
  if (ONLY_FILE) return [resolve(ONLY_FILE)]
  if (!existsSync(PROJECTS_DIR)) return []
  const out = []
  for (const slug of readdirSync(PROJECTS_DIR)) {
    const dir = join(PROJECTS_DIR, slug)
    if (!statSync(dir).isDirectory()) continue
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.jsonl')) out.push(join(dir, f))
    }
  }
  return out
}

const sessions = []
for (const file of collectFiles()) {
  const s = parse(file)
  if (!s) continue
  // 按 cwd 过滤：--file 时不过滤；否则默认只看当前项目（跨平台，靠 transcript 自带的 cwd，不猜 slug）
  if (!ONLY_FILE && !ALL_PROJECTS && s.cwd !== CWD) continue
  sessions.push(s)
}
sessions.sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || ''))

if (sessions.length === 0) {
  console.error(ONLY_FILE ? `没有解析出用量：${ONLY_FILE}` : `没有匹配 cwd=${CWD} 的会话（试试 --all）`)
  process.exit(1)
}

if (AS_JSON) {
  console.log(
    JSON.stringify(
      sessions.map((s) => ({
        file: s.file,
        title: s.title,
        model: s.model,
        turns: s.turns,
        sidechainTurns: s.sidechainTurns,
        toolCalls: s.toolCalls,
        input: s.input,
        cacheWrite: s.cacheWrite,
        cacheRead: s.cacheRead,
        output: s.output,
        cacheHitRate: hitRate(s),
        billable: billable(s),
        contextPeak: Math.max(...s.contexts, 0),
        contextFinal: s.contexts.at(-1) || 0,
        contextMean: s.contexts.length ? s.contexts.reduce((a, b) => a + b, 0) / s.contexts.length : 0,
        firstTs: s.firstTs,
        lastTs: s.lastTs,
        tools: Object.fromEntries([...s.tools.entries()].sort((a, b) => b[1] - a[1])),
      })),
      null,
      2,
    ),
  )
  process.exit(0)
}

console.log(
  `扫描 ${sessions.length} 个会话（${ALL_PROJECTS || ONLY_FILE ? '全部' : CWD}）` +
    `\n计费倍率假设：新输入 ${WEIGHTS[0]} / 缓存写 ${WEIGHTS[1]} / 缓存读 ${WEIGHTS[2]} / 输出 ${WEIGHTS[3]}` +
    `　—— 按你的 provider 实际价格用 --weights 覆盖\n`,
)

for (const s of sessions) {
  const peak = Math.max(...s.contexts, 0)
  const mean = s.contexts.length ? s.contexts.reduce((a, b) => a + b, 0) / s.contexts.length : 0
  const dur = s.firstTs && s.lastTs ? humanDuration(new Date(s.lastTs) - new Date(s.firstTs)) : '?'
  const top = [...s.tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)

  console.log('─'.repeat(78))
  console.log(`${s.title || '(无标题)'}  [${s.file.split('/').pop().slice(0, 8)}]`)
  console.log(`  模型        ${s.model || '?'}　${stamp(s.firstTs)} → ${stamp(s.lastTs)}（${dur}）`)
  console.log(`  轮次/工具   ${n(s.turns)} 轮（sidechain ${n(s.sidechainTurns)}）· ${n(s.toolCalls)} 次工具调用`)
  console.log(`  新输入      ${n(s.input)}`)
  console.log(`  缓存读      ${n(s.cacheRead)}　（缓存写 ${n(s.cacheWrite)}）`)
  console.log(`  输出        ${n(s.output)}`)
  console.log(
    `  缓存命中率  ${pct(hitRate(s))}　${
      hitRate(s) >= 0.9 ? '（前缀稳定，吃满了）' : hitRate(s) >= 0.5 ? '（偏低，前缀有抖动）' : '（很差，缓存基本没用上）'
    }`,
  )
  console.log(`  计费等效    ${n(Math.round(billable(s)))}　（vs 原始吞吐 ${n(s.input + s.cacheWrite + s.cacheRead + s.output)}）`)
  console.log(
    `  上下文      峰值 ${n(peak)} · 均值 ${n(Math.round(mean))} · 末轮 ${n(s.contexts.at(-1) || 0)}　${
      mean > 0 ? `（每轮重读均值 ${n(Math.round(mean))}）` : ''
    }`,
  )
  if (s.contexts.length > 1) console.log(`  增长曲线    ${sparkline(s.contexts)}`)
  if (top.length) console.log(`  工具分布    ${top.map(([k, v]) => `${k.replace(/^mcp__/, '')} ${v}`).join(' · ')}`)
}

// 汇总：换 harness / 换模型时最该盯的三个数
const total = sessions.reduce(
  (a, s) => ({
    turns: a.turns + s.turns,
    toolCalls: a.toolCalls + s.toolCalls,
    input: a.input + s.input,
    cacheWrite: a.cacheWrite + s.cacheWrite,
    cacheRead: a.cacheRead + s.cacheRead,
    output: a.output + s.output,
    billable: a.billable + billable(s),
    ctx: a.ctx + (s.contexts.reduce((x, y) => x + y, 0) || 0),
    ctxN: a.ctxN + s.contexts.length,
  }),
  { turns: 0, toolCalls: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, billable: 0, ctx: 0, ctxN: 0 },
)

console.log('─'.repeat(78))
console.log('合计')
console.log(`  轮次 ${n(total.turns)} · 工具调用 ${n(total.toolCalls)} · 每轮工具 ${(total.toolCalls / (total.turns || 1)).toFixed(2)}`)
console.log(`  缓存命中率 ${pct(hitRate(total))} · 每轮平均上下文 ${n(Math.round(total.ctx / (total.ctxN || 1)))}`)
console.log(`  计费等效 ${n(Math.round(total.billable))}`)
console.log(
  `\n提示：换 harness 对照时，比的是这三个数——缓存命中率、每轮平均上下文、每轮工具调用数。\n` +
    `     原始吞吐 = 每轮平均上下文 × 轮次，它是成本引擎；上下文越大，每轮越贵（线性）。`,
)
