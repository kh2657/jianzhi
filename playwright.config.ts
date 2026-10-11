import { defineConfig } from '@playwright/test'
import { cpus } from 'node:os'

// E2E 用 playwright 的 _electron 启动真实应用（out/ 产物 + 真实文件系统/IPC），不需要浏览器二进制。
//
// 并行前提（逐个核对过）：每个用例各自 mkdtempSync 建临时资料库；MATHWB_E2E=1 下随机端口、
// 窗口从不上屏、launchApp 之间不共享任何状态或路径；因此文件之间可以并行。
// 默认按 CPU 取 4–6 个 worker（每个 worker 会拉起 Electron，内存与 IO 都重，不铺满核数）；
// 排查并发相关问题时用 `E2E_WORKERS=1 npx playwright test` 回到串行。
const cpuCount = cpus().length
const defaultWorkers = Math.max(2, Math.min(6, Math.floor(cpuCount / 4)))

export default defineConfig({
  testDir: 'tests/e2e',
  // 文件内保持串行：同一个 spec 内的多步流程（导入 → 阅读 → 重启 → 再打开）本就依赖顺序，
  // 并行收益主要来自文件之间。需要全程独占时：E2E_WORKERS=1。
  fullyParallel: false,
  workers: Number(process.env.E2E_WORKERS ?? defaultWorkers),
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  outputDir: 'test-results'
})
