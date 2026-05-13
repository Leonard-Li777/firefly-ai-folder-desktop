import chokidar from 'chokidar';
import path from 'node:path';
import fs from 'node:fs';
import { logger, LogCategory } from '@yonuc/shared';
import { databaseService } from '../database/database-service';
import { analysisQueueService } from '../analysis-queue-service';
import { loadIgnoreRules, shouldIgnoreFile } from '../analysis/analysis-ignore-service';
import { ConfigOrchestrator } from '@app/electron/config/config-orchestrator';
import type { IIgnoreRule } from '@yonuc/types';
import { calculateFileFingerprint } from '@yonuc/core-engine';

/**
 * 文件监听服务类
 */
class FileWatcherService {
  private watchers: Map<number, ReturnType<typeof chokidar.watch>> = new Map();
  private ignoreRules: IIgnoreRule[] = [];
  private isInitialized = false;
  private syncingPaths: Set<string> = new Set();
  private notificationTimers: Map<string, NodeJS.Timeout> = new Map();
  private processingFiles: Set<string> = new Set(); // 防止同一文件重复处理
  private lastSyncTime: Map<string, number> = new Map(); // 记录每个目录的最后同步时间，防止频繁重复同步

  /**
   * 通知前端更新文件列表（带节流）
   * @param directoryPath 目录路径
   */
  private notifyDirectoryUpdate(directoryPath: string): void {
    if (this.notificationTimers.has(directoryPath)) {
      return;
    }

    // 设置 300ms 的节流
    const timer = setTimeout(async () => {
      try {
        const { BrowserWindow } = await import('electron');
        const windows = BrowserWindow.getAllWindows();
        if (windows.length > 0) {
          logger.debug(LogCategory.FILE_WATCHER, `发送目录更新通知: ${directoryPath}`);
          windows.forEach((win) => {
            if (!win.isDestroyed()) {
              win.webContents.send('directory-files-updated', directoryPath);
            }
          });
        }
      } catch (error) {
        logger.error(LogCategory.FILE_WATCHER, '发送目录更新通知失败:', error);
      } finally {
        this.notificationTimers.delete(directoryPath);
      }
    }, 300);

    this.notificationTimers.set(directoryPath, timer);
  }

  /**
   * 初始化文件监听服务
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.warn(LogCategory.FILE_WATCHER, '文件监听服务已经初始化');
      return;
    }

    try {
      logger.info(LogCategory.FILE_WATCHER, '初始化文件监听服务...');

      // 加载忽略规则
      this.ignoreRules = loadIgnoreRules();
      logger.info(LogCategory.FILE_WATCHER, `已加载 ${this.ignoreRules.length} 条忽略规则`);

      // 启动所有启用了 autoWatch 的工作目录的监听
      await this.startAllAutoWatchers();

      this.isInitialized = true;
      logger.info(LogCategory.FILE_WATCHER, '文件监听服务初始化成功');
    } catch (error) {
      logger.error(LogCategory.FILE_WATCHER, '文件监听服务初始化失败:', error);
      throw error;
    }
  }

  /**
   * 启动所有启用了 autoWatch 的工作目录的监听
   */
  async startAllAutoWatchers(): Promise<void> {
    try {
      const directories = await databaseService.getAllWorkspaceDirectories();
      const autoWatchDirs = directories.filter(dir => dir.autoWatch && dir.isActive);

      logger.info(LogCategory.FILE_WATCHER, `找到 ${autoWatchDirs.length} 个启用自动监听的目录`);

      for (const directory of autoWatchDirs) {
        if (directory.id) {
          await this.startWatching(directory.id, directory.path);
        }
      }
    } catch (error) {
      logger.error(LogCategory.FILE_WATCHER, '启动自动监听失败:', error);
      throw error;
    }
  }

  /**
   * 开始监听指定目录
   * @param workspaceId 工作目录ID
   * @param directoryPath 目录路径
   */
  async startWatching(workspaceId: number, directoryPath: string): Promise<void> {
    try {
      // 如果已经在监听，先停止
      if (this.watchers.has(workspaceId)) {
        logger.info(LogCategory.FILE_WATCHER, `目录 ${directoryPath} 已在监听中，先停止旧的监听器`);
        await this.stopWatching(workspaceId);
      }

      logger.info(LogCategory.FILE_WATCHER, `开始监听目录: ${directoryPath}`);

      // 创建监听器
      const watcher = chokidar.watch(directoryPath, {
        persistent: true,
        ignoreInitial: true, // 不触发初始文件的事件
        depth: 0, // 【关键】只监听直接子文件，不递归进入子目录
        awaitWriteFinish: {
          stabilityThreshold: 2000, // 文件稳定2秒后才触发事件（等待文件写入完成）
          pollInterval: 100
        },
        ignored: (filePath: string) => {
          // 检查是否应该忽略此文件
          const fileName = path.basename(filePath);
          return shouldIgnoreFile(filePath, fileName, this.ignoreRules);
        }
      });

      // 监听新增文件事件
      watcher.on('add', async (filePath: string) => {
        await this.handleFileAdded(workspaceId, directoryPath, filePath, true);
      });

      // 监听文件修改事件
      watcher.on('change', async (filePath: string) => {
        await this.handleFileChanged(workspaceId, directoryPath, filePath, true);
      });

      // 监听文件删除事件
      watcher.on('unlink', async (filePath: string) => {
        await this.handleFileDeleted(workspaceId, directoryPath, filePath);
      });

      // 监听错误事件
      watcher.on('error', (error: unknown) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(LogCategory.FILE_WATCHER, `监听目录 ${directoryPath} 时发生错误:`, errorMessage);
      });

      // 监听就绪事件
      watcher.on('ready', () => {
        logger.info(LogCategory.FILE_WATCHER, `目录 ${directoryPath} 监听就绪`);
      });

      this.watchers.set(workspaceId, watcher);
      logger.info(LogCategory.FILE_WATCHER, `成功启动对目录 ${directoryPath} 的监听`);
    } catch (error) {
      logger.error(LogCategory.FILE_WATCHER, `启动目录监听失败: ${directoryPath}`, error);
      throw error;
    }
  }

  /**
   * 停止监听指定目录
   * @param workspaceId 工作目录ID
   */
  async stopWatching(workspaceId: number): Promise<void> {
    try {
      const watcher = this.watchers.get(workspaceId);
      if (watcher) {
        await watcher.close();
        this.watchers.delete(workspaceId);
        logger.info(LogCategory.FILE_WATCHER, `已停止监听目录 ID: ${workspaceId}`);
      }
    } catch (error) {
      logger.error(LogCategory.FILE_WATCHER, `停止目录监听失败 ID: ${workspaceId}`, error);
      throw error;
    }
  }

  /**
   * 同步指定目录中的文件差异（即时对齐）
   * @param dirPath 目录路径
   * @param triggerAnalysis 是否触发新文件的分析（默认false，仅在文件监听器事件中使用）
   */
  async syncDirectory(dirPath: string, triggerAnalysis: boolean = false): Promise<void> {
    if (!this.isInitialized) {
      // 确保忽略规则已加载
      this.ignoreRules = loadIgnoreRules();
    }

    // 同步锁，防止同一个目录多次重叠同步
    if (this.syncingPaths.has(dirPath)) {
      logger.debug(LogCategory.FILE_WATCHER, `目录正在同步中，跳过: ${dirPath}`);
      return;
    }

    // 防止频繁重复同步：同一目录在 10 秒内不重复同步
    const now = Date.now();
    const lastSync = this.lastSyncTime.get(dirPath) || 0;
    if (now - lastSync < 10000) {
      logger.warn(LogCategory.FILE_WATCHER, `目录同步过于频繁 (${now - lastSync}ms < 10000ms)，跳过: ${dirPath}`);
      return;
    }
    this.lastSyncTime.set(dirPath, now);

    this.syncingPaths.add(dirPath);

    try {
      logger.debug(LogCategory.FILE_WATCHER, `开始异步同步目录: ${dirPath}`);

      // 1. 获取工作空间信息
      const workspace = await databaseService.findRootWorkspaceDirectory(dirPath);
      if (!workspace || !workspace.id) return;

      // 2. 检查工作目录是否仍然有效
      const allWorkspaces = await databaseService.getAllWorkspaceDirectories();
      if (!allWorkspaces.some(w => w.id === workspace.id)) return;

      // 3. 异步读取磁盘文件
      if (!fs.existsSync(dirPath)) return;
      const diskEntries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      const diskFiles = diskEntries.filter(e => e.isFile());

      const diskFileMap = new Map<string, fs.Stats>();

      // 分批获取文件状态
      const BATCH_SIZE = 50;
      for (let i = 0; i < diskFiles.length; i += BATCH_SIZE) {
        const batch = diskFiles.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (file) => {
          const fullPath = path.join(dirPath, file.name);
          // 采用原生路径，不进行归一化
          if (!shouldIgnoreFile(fullPath, file.name, this.ignoreRules)) {
            try {
              const stats = await fs.promises.stat(fullPath);
              diskFileMap.set(fullPath, stats);
            } catch (e) {
              // 文件可能已消失
            }
          }
        }));

        await new Promise(resolve => setTimeout(resolve, 10)); // 略微停顿，保证响应性
      }

      // 4. 读取数据库记录
      const dbFiles = await databaseService.getFilesByParentPath(dirPath, workspace.id);
      const dbFileMap = new Map<string, any>();
      for (const file of dbFiles) {
        // 直接使用数据库路径作为键进行比对
        dbFileMap.set(file.path, file);
      }

      // 5. 对比并对齐
      let totalChanges = 0;
      let changeCountSinceLastNotify = 0;

      // 处理新增和修改
      for (const [filePath, stats] of diskFileMap.entries()) {
        const dbFile = dbFileMap.get(filePath);
        let changed = false;

        // 跳过正在处理中的文件，防止重复处理
        if (this.processingFiles.has(filePath)) {
          logger.debug(LogCategory.FILE_WATCHER, `文件正在处理中，跳过同步检查: ${filePath}`);
          continue;
        }

        if (!dbFile) {
          // 【关键修复】在 syncDirectory 中不自动添加到分析队列，避免批量同步时触发大量分析
          // 只有在文件监听器检测到真实变化时才触发分析
          await this.handleFileAdded(workspace.id, dirPath, filePath, false);
          changed = true;
        } else {
          // 检查文件是否真的发生了变化
          // 1. 检查大小
          const sizeChanged = dbFile.size !== stats.size;
          
          // 2. 检查修改时间
          const timeDiff = Math.abs(dbFile.modifiedAt.getTime() - stats.mtime.getTime());
          const timeChanged = timeDiff > 1000;

          if (sizeChanged || timeChanged) {
            // 传递工作目录的自动监听状态，决定是否重新分析
            await this.handleFileChanged(workspace.id, dirPath, filePath, !!workspace.autoWatch);
            changed = true;
          }
        }

        if (changed) {
          totalChanges++;
          changeCountSinceLastNotify++;

          // 每发现 50 个变化就通知前端一次，实现渐进式显示
          if (changeCountSinceLastNotify >= 50) {
            this.notifyDirectoryUpdate(dirPath);
            changeCountSinceLastNotify = 0;
            // 停顿 50ms 释放 CPU 让给 UI 渲染
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        }
      }

      // 处理删除
      for (const [pathInDb, dbFile] of dbFileMap.entries()) {
        if (!diskFileMap.has(pathInDb)) {
          totalChanges++;
          await this.handleFileDeleted(workspace.id, dirPath, pathInDb);
        }
      }

      // 同步结束后的最终通知
      if (totalChanges > 0) {
        logger.info(LogCategory.FILE_WATCHER, `目录同步完成，共发现 ${totalChanges} 处变更: ${dirPath}`);
        this.notifyDirectoryUpdate(dirPath);
      }

    } catch (error) {
      logger.error(LogCategory.FILE_WATCHER, `同步目录失败: ${dirPath}`, error);
    } finally {
      this.syncingPaths.delete(dirPath);
    }
  }
  /**
   * 处理文件新增事件
   * @param workspaceId 工作目录ID
   * @param directoryPath 目录路径
   * @param filePath 文件完整路径
   * @param autoWatchEnabled 是否开启了自动监听（可选，若不传则从数据库查询或默认为true）
   */
  private async handleFileAdded(workspaceId: number, directoryPath: string, filePath: string, autoWatchEnabled?: boolean): Promise<void> {
    // 【防护1】检查是否正在处理此文件
    if (this.processingFiles.has(filePath)) {
      logger.debug(LogCategory.FILE_WATCHER, `文件正在处理中，跳过添加: ${filePath}`);
      return;
    }

    try {
      // 【防护2】检查文件是否已经在数据库中，避免重复添加
      let existingFile = null;
      try {
        existingFile = await databaseService.getFileByPath(filePath);
      } catch (dbError) {
        logger.debug(LogCategory.FILE_WATCHER, `查询文件是否存在时出错: ${filePath}`, dbError);
      }
      
      if (existingFile) {
        logger.debug(LogCategory.FILE_WATCHER, `文件已存在于数据库，跳过添加: ${filePath}`);
        return;
      }

      // 【防护3】标记为正在处理
      this.processingFiles.add(filePath);

      logger.info(LogCategory.FILE_WATCHER, `检测到新文件: ${filePath}`);

      if (!fs.existsSync(filePath)) {
        logger.warn(LogCategory.FILE_WATCHER, `文件不存在: ${filePath}`);
        return;
      }

      const stats = fs.statSync(filePath);
      if (!stats.isFile()) {
        logger.debug(LogCategory.FILE_WATCHER, `跳过非文件: ${filePath}`);
        return;
      }

      const fileId = await databaseService.addFileFromPath(filePath, directoryPath, workspaceId, true);
      logger.info(LogCategory.FILE_WATCHER, `文件已添加到数据库: ${filePath}, Fingerprint: ${fileId}`);

      const isAutoWatchActive = autoWatchEnabled ?? true;

      if (isAutoWatchActive) {
        // 检查文件是否已经被分析过（例如文件重命名或移动后触发的 add 事件）
        const fileRecord = await databaseService.getFileByPath(filePath);
        if (fileRecord && fileRecord.isAnalyzed) {
          logger.info(LogCategory.FILE_WATCHER, `文件已被分析过，跳过加入分析队列: ${filePath}`);
        } else {
          const fileName = path.basename(filePath);
          const fileExt = path.extname(filePath).toLowerCase();

          await analysisQueueService.addItems([
            {
              path: filePath,
              name: fileName,
              size: stats.size,
              type: fileExt || 'unknown'
            }
          ], false);

          logger.info(LogCategory.FILE_WATCHER, `文件已加入分析队列: ${filePath}`);
        }
      }

      this.notifyDirectoryUpdate(directoryPath);
    } catch (error) {
      logger.error(LogCategory.FILE_WATCHER, `处理新增文件失败: ${filePath}`, error);
    } finally {
      this.processingFiles.delete(filePath);
    }
  }

  private async handleFileChanged(workspaceId: number, directoryPath: string, filePath: string, autoWatchEnabled?: boolean): Promise<void> {
    if (this.processingFiles.has(filePath)) {
      logger.debug(LogCategory.FILE_WATCHER, `文件正在处理中，跳过修改处理: ${filePath}`);
      return;
    }
    this.processingFiles.add(filePath);

    try {
      logger.info(LogCategory.FILE_WATCHER, `检测到文件修改: ${filePath}`);

      if (!fs.existsSync(filePath)) {
        logger.warn(LogCategory.FILE_WATCHER, `文件不存在: ${filePath}`);
        return;
      }

      const stats = fs.statSync(filePath);
      if (!stats.isFile()) {
        logger.debug(LogCategory.FILE_WATCHER, `跳过非文件: ${filePath}`);
        return;
      }

      await databaseService.updateFileModifiedTime(filePath, stats.mtime);

      const file = await databaseService.getFileByPath(filePath);
      if (!file) {
        logger.warn(LogCategory.FILE_WATCHER, `数据库中未找到文件记录: ${filePath}`);
        return;
      }

      const isAutoWatchActive = autoWatchEnabled ?? true;

      if (isAutoWatchActive) {
        const contentHash = await calculateFileFingerprint(filePath)

        if (file.contentHash === contentHash && file.isAnalyzed) {
          logger.info(LogCategory.FILE_WATCHER, `文件内容无变化，跳过队列分析: ${filePath}`)
          return
        }

        const fileName = path.basename(filePath);
        const fileExt = path.extname(filePath).toLowerCase();

        await analysisQueueService.addItems([
          {
            path: filePath,
            name: fileName,
            size: stats.size,
            type: fileExt || 'unknown'
          }
        ], true);

        logger.info(LogCategory.FILE_WATCHER, `修改的文件已重新加入分析队列: ${filePath}`);
      }

      this.notifyDirectoryUpdate(directoryPath);
    } catch (error) {
      logger.error(LogCategory.FILE_WATCHER, `处理文件修改失败: ${filePath}`, error);
    } finally {
      this.processingFiles.delete(filePath);
    }
  }

  private async handleFileDeleted(workspaceId: number, directoryPath: string, filePath: string): Promise<void> {
    if (this.processingFiles.has(filePath)) {
      logger.debug(LogCategory.FILE_WATCHER, `文件正在处理中，跳过删除处理: ${filePath}`);
      return;
    }
    this.processingFiles.add(filePath);

    try {
      logger.info(LogCategory.FILE_WATCHER, `检测到文件删除: ${filePath}`);

      const file = await databaseService.getFileByPath(filePath);
      if (file) {
        const { FileCleanupService } = await import('./file-cleanup-service');
        const fileCleanupService = new FileCleanupService(databaseService.db!);
        await fileCleanupService.deleteFileAndCleanup(file.fileId || file.id);
        logger.info(LogCategory.FILE_WATCHER, `文件已从数据库中删除: ${filePath}`);
      }

      this.notifyDirectoryUpdate(directoryPath);
    } catch (error) {
      logger.error(LogCategory.FILE_WATCHER, `处理文件删除失败: ${filePath}`, error);
    } finally {
      this.processingFiles.delete(filePath);
    }
  }

  /**
   * 重新加载忽略规则
   */
  async reloadIgnoreRules(): Promise<void> {
    try {
      this.ignoreRules = loadIgnoreRules();
      logger.info(LogCategory.FILE_WATCHER, `[文件监听] 已重新加载 ${this.ignoreRules.length} 条忽略规则`);
    } catch (error) {
      logger.error(LogCategory.FILE_WATCHER, '[文件监听] 重新加载忽略规则失败:', error);
    }
  }

  async cleanup(): Promise<void> {
    try {
      logger.info(LogCategory.FILE_WATCHER, '清理文件监听服务...');

      for (const [workspaceId, watcher] of this.watchers.entries()) {
        await watcher.close();
        logger.debug(LogCategory.FILE_WATCHER, `已关闭监听器: ${workspaceId}`);
      }

      this.watchers.clear();
      this.isInitialized = false;

      logger.info(LogCategory.FILE_WATCHER, '文件监听服务已清理');
    } catch (error) {
      logger.error(LogCategory.FILE_WATCHER, '清理文件监听服务失败:', error);
      throw error;
    }
  }

  getWatcherCount(): number {
    return this.watchers.size;
  }

  isWatching(workspaceId: number): boolean {
    return this.watchers.has(workspaceId);
  }
}

export const fileWatcherService = new FileWatcherService();
