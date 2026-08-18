/**
 * Playwright Release 安装包端到端 (E2E) 测试配置
 * 专门用于在 CI/CD 流水线中驱动已打包/已安装的真实生产二进制，并生成独立 HTML 报告供 GitHub Pages 发布。
 */

import { defineConfig } from '@playwright/test'
import path from 'path'

const reportOutputDir = path.resolve(__dirname, '../reports/html')

export default defineConfig({
  testDir: '../suites',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1, // 生产二进制单实例执行，避免端口/资源冲突
  retries: 0,
  timeout: 180000, // 3分钟单套件超时

  expect: {
    timeout: 20000
  },

  reporter: [
    ['list'],
    [
      'html',
      {
        outputFolder: reportOutputDir,
        open: 'never'
      }
    ],
    [
      'json',
      {
        outputFile: path.resolve(__dirname, '../reports/test-results.json')
      }
    ]
  ],

  use: {
    screenshot: 'on', // 生产包测试建议保留关键步骤截图，丰富报告内容
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
    actionTimeout: 15000
  },

  projects: [
    {
      name: 'release-e2e',
      use: {}
    }
  ]
})
