#!/usr/bin/env node
/**
 * test:desktop 统一 CLI 启动器 (Ticket 02 Spec §2.2)
 *
 * 语法：
 * pnpm run test:desktop -- --track=<L1|L2a|L2b|L3> [--suite=<SUITE>] [--ui-mode=headed|headless] [--debug]
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DESKTOP_ROOT = path.resolve(__dirname, '..')

// 透传所有 CLI 参数
const args = process.argv.slice(2)

// 使用 node + tsx / esbuild 直接执行 runner cli
const cliEntry = path.join(DESKTOP_ROOT, 'pro', 'tests', 'e2e', 'runner', 'cli.ts')

const child = spawn(
  process.execPath,
  ['--import', 'tsx', cliEntry, ...args],
  {
    cwd: DESKTOP_ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'test'
    }
  }
)

child.on('exit', code => {
  process.exit(code ?? 1)
})
