import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { pdfjsCssScopePlugin } from './scripts/scope-pdfjs-css'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    }
  },
  renderer: {
    root: 'src/renderer',
    plugins: [pdfjsCssScopePlugin(), react()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer/src')
      }
    },
    server: {
      proxy: {
        // 开发模式下把 /api 代理到主进程的资产服务（端口见 .env）
        '/api': {
          target: `http://127.0.0.1:${process.env.MATHWB_ASSET_PORT ?? 17317}`,
          changeOrigin: false
        }
      }
    }
  }
})
