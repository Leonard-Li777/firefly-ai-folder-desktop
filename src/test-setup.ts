/// <reference path="./global.d.ts" />
/**
 * 测试环境设置文件
 * 仅注入全局变量与 @testing-library 扩展；不在此处定义任何 vi.mock 调用。
 *
 * ⚠️ 重要原则：
 * 1. 大多数测试用例应当走真实模块，避免在全局 setup 中 mock 第三方库。
 * 2. 如果某个测试需要 mock electron / electron-conf / @app/languages /
 *    @voerkai18n/runtime / @firefly/core-engine 等模块，请：
 *    - 优先使用 `tests/unit/mocks/` 下导出的共享 mock 工厂；
 *    - 在测试文件顶层用 `vi.mock(...)` 调用，以便 vitest 提升（hoist）到所有 import 之前。
 * 3. 共享 mock 详见 `tests/unit/mocks/index.ts`：
 *    - `electron-mock.ts`          → electron / electron-conf
 *    - `language-mock.ts`          → @app/languages / @voerkai18n/runtime / core-engine languages
 *    - `electron-api-mock.ts`      → 渲染进程 window.electronAPI 桥接
 *    - `better-sqlite3-mock.ts`    → better-sqlite3
 *    - `node-mocks.ts`             → fs / fs/promises / child_process / net / os
 *    - `core-engine-mocks.ts`      → pdfjs-dist / exifr / music-metadata / ffmpeg-static / textract
 *    - `supabase-mock.ts`          → @firefly/server
 *    - `platform-adapter-mock.ts`  → platformAdapter spy 工具
 */

import '@testing-library/jest-dom'
import { vi } from 'vitest'

// 全局变量设置
;(globalThis as unknown as { vi: typeof vi }).vi = vi
;(globalThis as any).__APP_VERSION__ = '2.2.0'
;(globalThis as any).__BUILD_REGION__ = 'CN'
;(globalThis as any).__AI_ENGINE__ = 'llama.cpp'
;(globalThis as any).__IS_DEV__ = true
;(globalThis as any).__IS_PROD__ = false

// 捕获 EPIPE (broken pipe) 错误，防止测试中断或终端关闭时触发 Electron 弹窗崩溃
if (typeof process !== 'undefined') {
  process.stdout?.on?.('error', (err: any) => {
    if (err?.code === 'EPIPE' || err?.code === 'ERR_STREAM_DESTROYED') {
      process.exit(0)
    }
  })
  process.stderr?.on?.('error', (err: any) => {
    if (err?.code === 'EPIPE' || err?.code === 'ERR_STREAM_DESTROYED') {
      process.exit(0)
    }
  })
  process.on?.('uncaughtException', (err: any) => {
    if (err?.code === 'EPIPE' || err?.code === 'ERR_STREAM_DESTROYED' || String(err?.message || '').includes('EPIPE')) {
      process.exit(0)
    }
  })
}

