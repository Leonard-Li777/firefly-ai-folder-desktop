/**
 * 设置相关 IPC 处理器
 * 负责处理前端关于系统设置、忽略规则、工作目录管理的请求
 */
import { ipcMain, BrowserWindow } from 'electron';
import { logger, LogCategory } from '@yonuc/shared';
import { databaseService } from '../database/database-service';
import { configService } from '../config/config-service';
import { loadIgnoreRules, getSystemIgnoreRules } from '../analysis/analysis-ignore-service';
import type { IIgnoreRule } from '@yonuc/types/settings-types';
import fs from 'node:fs';
import path from 'node:path';
import { t } from '@app/languages';

/** 校验忽略规则类型 */
function isValidIgnoreRuleType(value: unknown): value is IIgnoreRule['type'] {
  return value === 'file' || value === 'directory' || value === 'extension' || value === 'regex' || value === 'wildcard' || value === 'pattern'
}

/** 生成唯一的忽略规则 ID */
function generateIgnoreRuleId(): string {
  return `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 保存忽略规则（到统一配置）
 */
async function saveIgnoreRulesToConfig(rules: IIgnoreRule[]): Promise<void> {
  const systemRules = getSystemIgnoreRules()
  const systemIds = new Set(systemRules.map(r => r.id))
  const sanitizedUserRules: IIgnoreRule[] = []

  if (Array.isArray(rules)) {
    for (const rule of rules) {
      if (!rule || typeof rule !== 'object') continue
      if (rule.isSystem) continue

      const id = typeof rule.id === 'string' && rule.id.trim().length > 0 ? rule.id : generateIgnoreRuleId()
      if (systemIds.has(id)) continue
      if (!isValidIgnoreRuleType(rule.type)) continue
      if (typeof rule.value !== 'string' || rule.value.trim().length === 0) continue

      sanitizedUserRules.push({
        id,
        type: rule.type,
        value: rule.value,
        isSystem: false,
        isActive: typeof rule.isActive === 'boolean' ? rule.isActive : true,
        description: rule.description
      })
    }
  }

  try {
    const finalRules = [...systemRules, ...sanitizedUserRules]
    await configService.updateValue('IGNORE_RULES', finalRules)
  } catch (error) {
    logger.error(LogCategory.SETTING, '保存忽略规则到统一配置失败:', error)
    throw error
  }
}

/** 注册设置相关的 IPC 处理器 */
export function registerSettingsIPCHandlers(): void {
  // 获取 AI 分析忽略规则
  ipcMain.handle('getAnalysisIgnoreRules', async () => {
    try {
      return loadIgnoreRules();
    } catch (error) {
      logger.error(LogCategory.SETTING, 'IPC 获取忽略规则失败:', error);
      return [];
    }
  });

  // 保存 AI 分析忽略规则
  ipcMain.handle('saveAnalysisIgnoreRules', async (event, rules: IIgnoreRule[]) => {
    try {
      // 1. 保存到持久化配置
      await saveIgnoreRulesToConfig(rules);

      // 2. 异步通知其他服务重载（不阻塞 IPC 返回）
      setImmediate(async () => {
        try {
          // 通知分析队列
          const { analysisQueueService } = await import('../analysis-queue-service');
          if (analysisQueueService && typeof analysisQueueService.reloadIgnoreRules === 'function') {
            analysisQueueService.reloadIgnoreRules();
          }

          // 通知文件监听服务
          const { fileWatcherService } = await import('../filesystem/file-watcher-service');
          if (fileWatcherService && typeof fileWatcherService.reloadIgnoreRules === 'function') {
            await fileWatcherService.reloadIgnoreRules();
          }

          // 通知渲染进程刷新
          const windows = BrowserWindow.getAllWindows();
          windows.forEach(win => {
            if (!win.isDestroyed()) {
              win.webContents.send('ignore-rules-changed');
            }
          });
        } catch (notifyError) {
          logger.warn(LogCategory.SETTING, '保存规则后的服务通知失败:', notifyError);
        }
      });

      return { success: true };
    } catch (error) {
      logger.error(LogCategory.SETTING, '保存忽略规则 IPC 处理失败:', error);
      throw error;
    }
  });

  // 删除工作目录及其关联数据
  ipcMain.handle('delete-workspace-directory', async (event, idOrPath: number | string) => {
    try {
      let workspaceId: number | undefined;
      let directoryPath: string | undefined;

      if (typeof idOrPath === 'number') {
        workspaceId = idOrPath;
        const ws = await databaseService.getWorkspaceDirectoryById(workspaceId);
        directoryPath = ws?.path;
      } else {
        directoryPath = idOrPath;
        const ws = await databaseService.findRootWorkspaceDirectory(directoryPath);
        workspaceId = ws?.id;
      }

      if (!directoryPath) {
        logger.warn(LogCategory.SETTING, '删除工作目录失败：未找到目录路径', { idOrPath });
        return { success: false, error: 'Workspace not found' };
      }

      logger.info(LogCategory.SETTING, '开始删除工作目录:', directoryPath);

      // 步骤 0: 停止文件监听
      if (workspaceId) {
        const { fileWatcherService } = await import('../filesystem/file-watcher-service');
        await fileWatcherService.stopWatching(workspaceId);
      }

      // 步骤 1: 删除关联的 .VirtualDirectory 文件夹
      const virtualDirPath = path.join(directoryPath, '.VirtualDirectory');
      if (fs.existsSync(virtualDirPath)) {
        try {
          await fs.promises.rm(virtualDirPath, { recursive: true, force: true });
          logger.info(LogCategory.SETTING, '.VirtualDirectory 文件夹删除成功');
        } catch (fsError) {
          logger.error(LogCategory.SETTING, '删除 .VirtualDirectory 失败:', fsError);
        }
      }

      // 步骤 2: 从数据库删除记录
      await databaseService.deleteWorkspaceDirectory(directoryPath);

      // 步骤 3: 删除队列中的相关文件
      try {
        const { analysisQueueService } = await import('../analysis-queue-service');
        if (analysisQueueService) {
          analysisQueueService.deleteItemsByDirectory(directoryPath);
        }
      } catch (queueError) {
        logger.error(LogCategory.SETTING, '清理分析队列失败:', queueError);
      }

      // 步骤 4: 通知渲染进程刷新
      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) {
          win.webContents.send('workspace-directories-updated');
        }
      });

      return { success: true };
    } catch (error) {
      logger.error(LogCategory.SETTING, '删除工作目录失败:', error);
      throw error;
    }
  });

  // 重置工作目录的 AI 分析数据
  ipcMain.handle('reset-workspace-directory', async (event, idOrPath: number | string) => {
    try {
      let directoryPath: string | undefined;

      if (typeof idOrPath === 'number') {
        const ws = await databaseService.getWorkspaceDirectoryById(idOrPath);
        directoryPath = ws?.path;
      } else {
        directoryPath = idOrPath;
      }

      if (directoryPath) {
        await databaseService.resetWorkspaceDirectoryAnalysis(directoryPath);
        
        // 通知渲染进程刷新
        BrowserWindow.getAllWindows().forEach(win => {
          if (!win.isDestroyed()) {
            win.webContents.send('workspace-directories-updated');
          }
        });
        
        return { success: true };
      }
      return { success: false, error: 'Workspace not found' };
    } catch (error) {
      logger.error(LogCategory.SETTING, '重置工作目录数据失败:', error);
      throw error;
    }
  });

  // 扫描工作目录 (旧版别名支持)
  const handleScan = async (event: any, workspaceId: number) => {
    try {
      const workspace = await databaseService.getWorkspaceDirectoryById(workspaceId);
      if (!workspace) return { success: false, error: 'Workspace not found' };

      const { fileWatcherService } = await import('../filesystem/file-watcher-service');
      await fileWatcherService.syncDirectory(workspace.path, true);
      
      // 更新最后扫描时间
      await databaseService.updateWorkspaceDirectoryLastScan(workspaceId);
      
      return { success: true };
    } catch (error) {
      logger.error(LogCategory.SETTING, '扫描目录失败:', error);
      throw error;
    }
  };

  ipcMain.handle('scan-workspace-directory', handleScan);
  ipcMain.handle('rescanWorkspaceDirectory', handleScan);

  // 更新工作目录的 autoWatch 状态
  ipcMain.handle('update-workspace-directory-auto-watch', async (event, workspaceId: number, autoWatch: boolean) => {
    try {
      logger.info(LogCategory.SETTING, '更新工作目录 autoWatch 状态:', { workspaceId, autoWatch });

      // 更新数据库
      await databaseService.updateAutoWatch(workspaceId, autoWatch);

      // 启动或停止文件监听
      const { fileWatcherService } = await import('../filesystem/file-watcher-service');
      const directory = await databaseService.getWorkspaceDirectoryById(workspaceId);

      if (!directory) {
        throw new Error(t('未找到工作目录 ID: {workspaceId}', { workspaceId }));
      }

      if (autoWatch && directory.isActive) {
        await fileWatcherService.startWatching(workspaceId, directory.path);
      } else {
        await fileWatcherService.stopWatching(workspaceId);
      }

      return { success: true };
    } catch (error) {
      logger.error(LogCategory.SETTING, '更新工作目录 autoWatch 状态失败:', error);
      throw error;
    }
  });

  // 重置 AI 分析数据库
  ipcMain.handle('resetAnalysisDatabase', async () => {
    try {
      logger.info(LogCategory.SETTING, '重置 AI 分析数据库...');
      await databaseService.resetAllAnalysisData();
      
      // 清理所有工作目录的 .VirtualDirectory (可选，但建议)
      const workspaces = await databaseService.getAllWorkspaceDirectories();
      for (const ws of workspaces) {
        const vdir = path.join(ws.path, '.VirtualDirectory');
        if (fs.existsSync(vdir)) {
          try {
            await fs.promises.rm(vdir, { recursive: true, force: true });
          } catch (e) {}
        }
      }

      return { success: true };
    } catch (error) {
      logger.error(LogCategory.SETTING, '重置 AI 分析数据库失败:', error);
      throw error;
    }
  });
}
