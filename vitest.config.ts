import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') }
  },
  test: {
    include: ['tests/*.spec.ts'],
    environment: 'node',
    testTimeout: 30000,
    // 收尾（清理临时库）与建库都在 hook 里；hookTimeout 与 testTimeout 分开设，
    // 避免大库用例的收尾把整个套件判失败。
    hookTimeout: 60000
  }
})
