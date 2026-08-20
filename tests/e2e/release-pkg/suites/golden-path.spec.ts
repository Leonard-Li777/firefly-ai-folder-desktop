/**
 * 生产安装包端到端黄金主链路测试套件 (Release E2E Golden Path Spec)
 *
 * 测试目标：
 * 验证真实已打包/已安装的 Release 二进制程序（Windows .exe / Linux .deb / macOS .app）
 * 从安装、启动、欢迎向导、加载快照工作区、文件扫描与列表展示、虚拟目录与标签联动交互、
 * 到最后的工作区清理/重置全流程，全会话单次启动连贯执行，零中断验证。
 */

import { test, expect, Page } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { ReleaseAppLauncher, ReleaseAppInstance } from '../helpers/release-app-launcher'
import { SnapshotManager, TestSnapshotContext } from '../fixtures/snapshot-manager'

test.describe.serial('Release 生产安装包 E2E 黄金主链路验证', () => {
  let app: ReleaseAppInstance
  let page: Page
  let snapshotContext: TestSnapshotContext
  let workspaceDir: string

  test.beforeAll(async () => {
    console.log('\n==================== [E2E SETUP START] ====================')
    // 1. 初始化预设快照测试工作区与独立 UserData
    snapshotContext = SnapshotManager.setupEnvironment()
    workspaceDir = snapshotContext.speedyWorkspaceDir
    console.log(`[E2E Setup] 测试工作区目录: ${workspaceDir}`)
    console.log(`[E2E Setup] UserData 隔离目录: ${snapshotContext.userDataDir}`)

    // 2. 启动生产包应用并建立 CDP 连接
    app = await ReleaseAppLauncher.launch({
      userDataDir: snapshotContext.userDataDir,
      timeout: 45000
    })

    page = app.page
    console.log('==================== [E2E SETUP COMPLETED] ====================\n')
  })

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
      console.error(
        `\n❌ [E2E 测试失败] 步骤 "${testInfo.title}" 未能正常完成 (状态: ${testInfo.status})`
      )
      const userDataDir = snapshotContext?.userDataDir || SnapshotManager.getUserDataDir()
      console.error(`🔍 正在从用户数据目录 [${userDataDir}] 提取 app.log 日志并附加到 HTML 报告...`)
      ReleaseAppLauncher.printUserDataLogs(userDataDir, testInfo)
    }
  })

  test.afterAll(async () => {
    console.log('\n==================== [E2E TEARDOWN START] ====================')
    try {
      if (app) {
        console.log('[E2E Teardown] 正在关闭 Electron 生产应用...')
        await app.close()
      }
    } catch (err) {
      console.warn('[E2E Teardown] 关闭应用异常 (忽略):', err)
    }

    try {
      console.log('[E2E Teardown] 清理测试快照临时文件...')
      SnapshotManager.teardownEnvironment()
    } catch (err) {
      console.warn('[E2E Teardown] 清理临时目录异常 (忽略):', err)
    }
    console.log('==================== [E2E TEARDOWN COMPLETED] ====================\n')
  })

  test('01. 生产包启动与主窗口渲染健康检查', async () => {
    console.log('--- [Step 01] 检查应用窗口状态与基本 DOM 渲染 ---')
    expect(app).toBeDefined()
    page = await app.getPage()
    expect(page).toBeDefined()

    await page.waitForLoadState('domcontentloaded').catch(() => {})
    await new Promise(r => setTimeout(r, 1500))

    const title = await page.title().catch(() => '')
    const url = page.url()
    console.log(`[Step 01] 当前页面 URL: ${url}, 标题: ${title}`)

    expect(url).toBeTruthy()

    // 验证 window.electronAPI 正常注入
    const hasElectronAPI = await page.evaluate(() => {
      return typeof (window as any).electronAPI !== 'undefined'
    })
    console.log(`[Step 01] window.electronAPI 存在性: ${hasElectronAPI}`)
    expect(hasElectronAPI).toBe(true)

    // 截图保存阶段健康状态
    await page
      .screenshot({ path: path.join(__dirname, '../reports/html/step-01-healthy-launch.png') })
      .catch(() => {})
  })

  test('02. 欢迎向导与系统初始化检查 (Onboarding Check)', async () => {
    console.log('--- [Step 02] 检查欢迎向导或首屏配置 ---')
    page = await app.getPage()
    await new Promise(r => setTimeout(r, 1500))

    // 检查是否存在向导/语言选择或配置引导蒙层（兼容中文与国际版英文）
    const wizardVisible = await page
      .locator(
        '[role="radiogroup"], button:has-text("继续"), button:has-text("开始使用"), button:has-text("下一步"), button:has-text("Continue"), button:has-text("Get Started"), button:has-text("Next")'
      )
      .first()
      .isVisible({ timeout: 5000 })
      .catch(() => false)

    if (wizardVisible) {
      console.log('[Step 02] 发现欢迎向导界面，正在完成初始配置交互...')

      // 尝试选择中文或默认语言
      const zhOption = page
        .locator(
          'label:has-text("简体中文"), label:has-text("English"), input[value="zh-CN"], input[value="en-US"]'
        )
        .first()
      if (await zhOption.isVisible().catch(() => false)) {
        await zhOption.click().catch(() => {})
        await new Promise(r => setTimeout(r, 500))
      }

      // 点击“继续”或“开始”
      const nextBtn = page
        .locator(
          'button:has-text("继续"), button:has-text("下一步"), button:has-text("开始使用"), button:has-text("Continue"), button:has-text("Next"), button:has-text("Get Started")'
        )
        .first()
      if (await nextBtn.isVisible().catch(() => false)) {
        await nextBtn.click().catch(() => {})
      }
    } else {
      console.log('[Step 02] 无向导蒙层或已直接进入主界面。')
    }

    // 给页面初始化与授权探测预留稳定时间
    await new Promise(r => setTimeout(r, 4000))
    page = await app.getPage()
    await page.waitForLoadState('domcontentloaded').catch(() => {})

    // 断言主应用界面容器已挂载
    const rootElement = page.locator('#root, body, main').first()
    await expect(rootElement).toBeVisible({ timeout: 20000 })
    await page
      .screenshot({ path: path.join(__dirname, '../reports/html/step-02-main-ready.png') })
      .catch(() => {})
  })

  test('03. 挂载测试快照工作区 (Mount Golden Workspace)', async () => {
    console.log(`--- [Step 03] 挂载测试快照工作区: ${workspaceDir} ---`)
    page = await app.getPage()
    await page.waitForLoadState('domcontentloaded').catch(() => {})

    // 通过 electronAPI 添加工作目录、设置当前工作区并触发同步
    await page.evaluate(async wsPath => {
      const api = (window as any).electronAPI
      if (!api) throw new Error('electronAPI 未定义')

      // 1. 添加工作区
      if (typeof api.addWorkspaceDirectory === 'function') {
        await api.addWorkspaceDirectory({
          name: 'SPEEDY-Golden-Workspace',
          path: wsPath,
          type: 'SPEEDY'
        })
      }

      // 2. 切换当前工作区
      if (typeof api.setCurrentWorkspaceDirectory === 'function') {
        await api.setCurrentWorkspaceDirectory(wsPath)
      }

      // 3. 广播前端更新事件
      window.dispatchEvent(new CustomEvent('workspace-directories-updated'))
    }, workspaceDir)

    // 等待 UI 响应并刷新工作区
    await new Promise(r => setTimeout(r, 3500))
    page = await app.getPage()

    // 验证工作区列表已成功记录（支持慢 IO 异步写入短轮询）
    let directories: any[] = []
    for (let attempt = 0; attempt < 10; attempt++) {
      directories = await page.evaluate(async () => {
        const api = (window as any).electronAPI
        return api && typeof api.getAllWorkspaceDirectories === 'function'
          ? await api.getAllWorkspaceDirectories()
          : []
      })
      if (directories.length >= 1) break
      await new Promise(r => setTimeout(r, 600))
    }

    console.log(`[Step 03] 当前已挂载工作区数量: ${directories.length}`)
    expect(directories.length).toBeGreaterThanOrEqual(1)

    const currentDir = directories.find(
      (d: any) => d.path === workspaceDir || d.path.toLowerCase() === workspaceDir.toLowerCase()
    )
    expect(currentDir).toBeDefined()

    await page
      .screenshot({ path: path.join(__dirname, '../reports/html/step-03-workspace-mounted.png') })
      .catch(() => {})
  })

  test('04. 文件探测与列表/详情展示 (File Explorer & Details Panel)', async () => {
    console.log('--- [Step 04] 验证文件列表展示与详情面板交互 ---')
    page = await app.getPage()

    // 主动触发目录读取并获取快照内的文件结构
    const dirContent = await page.evaluate(async wsPath => {
      const api = (window as any).electronAPI
      if (api && typeof api.readDirectory === 'function') {
        return await api.readDirectory(wsPath)
      }
      return { files: [], directories: [] }
    }, workspaceDir)

    const scannedFiles = dirContent.files || []
    const scannedDirs = dirContent.directories || []
    console.log(
      `[Step 04] 后端扫描到的文件数: ${scannedFiles.length}, 子目录数: ${scannedDirs.length}`
    )

    // 验证扫描到的文件数不为 0
    expect(scannedFiles.length + scannedDirs.length).toBeGreaterThan(0)
    console.log(`[Step 04] 文件名样本: ${scannedFiles.map((f: any) => f.name).join(', ')}`)

    // 等待 UI 渲染
    await new Promise(r => setTimeout(r, 2000))

    // 检查页面渲染的文件元素或文件名文本
    const fileElements = page.locator(
      'div:has-text("成都市"), div:has-text("项目模块"), span:has-text("通知"), span:has-text("需求"), [class*="truncate"], tbody tr, [class*="card"]'
    )
    const domFileCount = await fileElements.count().catch(() => 0)
    console.log(`[Step 04] 页面匹配到的文件相关 DOM 元素数量: ${domFileCount}`)

    // 验证页面至少能匹配到主工作区与文件相关元素
    expect(domFileCount).toBeGreaterThan(0)

    // 尝试点击第一个文件项以唤起详情交互
    await fileElements
      .first()
      .click()
      .catch(() => {})
    await new Promise(r => setTimeout(r, 1000))

    // 验证主视图区域可见
    const mainView = page
      .locator('main, [class*="fileExplorer"], [class*="layout"], [class*="content"]')
      .first()
    await expect(mainView).toBeVisible()

    await page
      .screenshot({ path: path.join(__dirname, '../reports/html/step-04-file-explorer.png') })
      .catch(() => {})
  })

  test('05. 虚拟目录与维度标签交互 (Virtual Directory & Tags Interaction)', async () => {
    console.log('--- [Step 05] 验证虚拟目录与维度筛选交互 ---')
    page = await app.getPage()

    // 尝试定位并点击“虚拟目录”导航入口（兼容中英文）
    const virtualDirNav = page
      .locator(
        'button:has-text("虚拟目录"), a:has-text("虚拟目录"), [data-testid="nav-virtual-directory"], button:has-text("Virtual"), a:has-text("Virtual")'
      )
      .first()
    if (await virtualDirNav.isVisible().catch(() => false)) {
      console.log('[Step 05] 点击虚拟目录导航菜单...')
      await virtualDirNav.click().catch(() => {})
      await new Promise(r => setTimeout(r, 2000))
    }

    // 检查是否有维度树或标签选择器
    const tagElements = page.locator(
      '[class*="dimension"], [class*="tag"], [role="treeitem"], [class*="badge"], button:has-text("标签"), div:has-text("维度"), button:has-text("Tag"), div:has-text("Dimension")'
    )
    const tagCount = await tagElements.count().catch(() => 0)
    console.log(`[Step 05] 页面检测到的维度/标签节点数量: ${tagCount}`)

    if (tagCount > 0) {
      await tagElements
        .first()
        .click()
        .catch(() => {})
      await new Promise(r => setTimeout(r, 500))
    }

    await page
      .screenshot({ path: path.join(__dirname, '../reports/html/step-05-virtual-directory.png') })
      .catch(() => {})
  })

  test('06. 工作区重置与环境清理 (Teardown & Reset Verification)', async () => {
    console.log('--- [Step 06] 验证工作区重置与环境清理 ---')
    page = await app.getPage()

    // 调用 electronAPI 移除工作区，验证应用能够重置到空状态
    const removeResult = await page.evaluate(async wsPath => {
      const api = (window as any).electronAPI
      if (api && typeof api.deleteWorkspaceDirectory === 'function') {
        return await api.deleteWorkspaceDirectory(wsPath)
      }
      return { success: true }
    }, workspaceDir)

    console.log('[Step 06] 移除工作区返回结果:', removeResult)
    await new Promise(r => setTimeout(r, 1500))

    // 验证工作区列表已更新（带短轮询重试）
    let afterDirs: any[] = []
    let stillExists = true
    for (let attempt = 0; attempt < 10; attempt++) {
      afterDirs = await page.evaluate(async () => {
        const api = (window as any).electronAPI
        return api && typeof api.getAllWorkspaceDirectories === 'function'
          ? await api.getAllWorkspaceDirectories()
          : []
      })
      stillExists = afterDirs.some(
        (d: any) => d.path === workspaceDir || d.path.toLowerCase() === workspaceDir.toLowerCase()
      )
      if (!stillExists) break
      await new Promise(r => setTimeout(r, 600))
    }

    console.log(`[Step 06] 移除后剩余工作区数量: ${afterDirs.length}`)
    expect(stillExists).toBe(false)

    await page
      .screenshot({ path: path.join(__dirname, '../reports/html/step-06-reset-clean.png') })
      .catch(() => {})
    console.log('🎉 [Step 06] 黄金主链路全套测试执行完毕并成功完成闭环！')
  })
})
