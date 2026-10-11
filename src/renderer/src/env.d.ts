/// <reference types="vite/client" />
import type { MathApi } from '@shared/api'

declare global {
  interface Window {
    api: MathApi
  }
}

export {}
