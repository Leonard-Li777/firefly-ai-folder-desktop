/**
 * 测试快照与临时环境管理器
 * 负责在测试运行前准备独立的测试样本工作区与 UserData 目录，并在测试中/后支持重置与清理。
 * 精准对接 tests/work-folder/SPEEDY 与 tests/work-folder/PRIVATE 真实样本库。
 */

import fs from 'fs'
import path from 'path'
import os from 'os'

export interface TestSnapshotContext {
  workspaceDir: string
  speedyWorkspaceDir: string
  privateWorkspaceDir: string
  userDataDir: string
  fixtureSourceDir: string
}

export class SnapshotManager {
  private static runId = `${Date.now()}-${Math.floor(Math.random() * 1000)}`
  private static rootTempDir = path.join(os.tmpdir(), `firefly-e2e-${SnapshotManager.runId}`)
  private static speedyWorkspaceDir = path.join(SnapshotManager.rootTempDir, 'speedy-ws')
  private static privateWorkspaceDir = path.join(SnapshotManager.rootTempDir, 'private-ws')
  private static userDataDir = path.join(SnapshotManager.rootTempDir, 'userdata')

  // __dirname: <repo>/tests/e2e/release-pkg/fixtures
  // 向上 3 级即达 <repo>/tests
  private static repoSpeedyDir = path.resolve(__dirname, '../../../work-folder/SPEEDY')
  private static repoPrivateDir = path.resolve(__dirname, '../../../work-folder/PRIVATE')

  /**
   * 递归复制目录（包含隐藏文件和子目录如 .VirtualDirectory）
   */
  private static copyDirRecursive(src: string, dest: string): void {
    if (!fs.existsSync(src)) return
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true })
    }

    const entries = fs.readdirSync(src, { withFileTypes: true })
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name)
      const destPath = path.join(dest, entry.name)
      if (entry.isDirectory()) {
        this.copyDirRecursive(srcPath, destPath)
      } else if (entry.isFile()) {
        fs.copyFileSync(srcPath, destPath)
      }
    }
  }

  /**
   * 初始化/准备一套全新的测试快照工作区与 UserData 目录
   */
  public static setupEnvironment(): TestSnapshotContext {
    console.log(`[SnapshotManager] SPEEDY 源路径: ${this.repoSpeedyDir} (存在: ${fs.existsSync(this.repoSpeedyDir)})`)
    console.log(`[SnapshotManager] PRIVATE 源路径: ${this.repoPrivateDir} (存在: ${fs.existsSync(this.repoPrivateDir)})`)

    // 1. 创建干净的临时根目录
    fs.mkdirSync(this.rootTempDir, { recursive: true })
    fs.mkdirSync(this.speedyWorkspaceDir, { recursive: true })
    fs.mkdirSync(this.privateWorkspaceDir, { recursive: true })
    fs.mkdirSync(this.userDataDir, { recursive: true })

    // 2. 从 tests/work-folder/SPEEDY 复制样本
    if (fs.existsSync(this.repoSpeedyDir)) {
      this.copyDirRecursive(this.repoSpeedyDir, this.speedyWorkspaceDir)
      console.log(`[SnapshotManager] 已成功拷贝 SPEEDY 样本到: ${this.speedyWorkspaceDir}`)
    }

    // 3. 从 tests/work-folder/PRIVATE 复制样本
    if (fs.existsSync(this.repoPrivateDir)) {
      this.copyDirRecursive(this.repoPrivateDir, this.privateWorkspaceDir)
      console.log(`[SnapshotManager] 已成功拷贝 PRIVATE 样本到: ${this.privateWorkspaceDir}`)
    }

    return {
      workspaceDir: this.speedyWorkspaceDir,
      speedyWorkspaceDir: this.speedyWorkspaceDir,
      privateWorkspaceDir: this.privateWorkspaceDir,
      userDataDir: this.userDataDir,
      fixtureSourceDir: this.repoSpeedyDir
    }
  }

  /**
   * 重置工作区目录（从 tests/work-folder 复制恢复）
   */
  public static resetWorkspace(): string {
    if (fs.existsSync(this.speedyWorkspaceDir)) {
      try {
        fs.rmSync(this.speedyWorkspaceDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 })
      } catch {}
    }
    if (fs.existsSync(this.privateWorkspaceDir)) {
      try {
        fs.rmSync(this.privateWorkspaceDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 })
      } catch {}
    }

    fs.mkdirSync(this.speedyWorkspaceDir, { recursive: true })
    fs.mkdirSync(this.privateWorkspaceDir, { recursive: true })

    // 从 tests/work-folder/SPEEDY 复制到 speedyWorkspaceDir
    if (fs.existsSync(this.repoSpeedyDir)) {
      this.copyDirRecursive(this.repoSpeedyDir, this.speedyWorkspaceDir)
      console.log(`[SnapshotManager] 已成功拷贝 SPEEDY 样本到: ${this.speedyWorkspaceDir}`)
    }

    // 从 tests/work-folder/PRIVATE 复制到 privateWorkspaceDir
    if (fs.existsSync(this.repoPrivateDir)) {
      this.copyDirRecursive(this.repoPrivateDir, this.privateWorkspaceDir)
      console.log(`[SnapshotManager] 已成功拷贝 PRIVATE 样本到: ${this.privateWorkspaceDir}`)
    }

    return this.speedyWorkspaceDir
  }

  /**
   * 清空整个测试环境（测试结束后调用）
   */
  public static teardownEnvironment(): void {
    try {
      if (fs.existsSync(this.rootTempDir)) {
        fs.rmSync(this.rootTempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 })
      }
    } catch {}
  }

  public static getWorkspaceDir(): string {
    return this.speedyWorkspaceDir
  }

  public static getUserDataDir(): string {
    return this.userDataDir
  }
}
