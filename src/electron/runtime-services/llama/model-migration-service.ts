import * as fs from 'fs-extra';
import * as path from 'path';
import { app, BrowserWindow } from 'electron';
import { LogCategory, logger } from '@yonuc/shared';
import { ConfigOrchestrator } from '../../config/config-orchestrator';
import { unifiedModelManager } from './unified-model-manager';

/**
 * 模型迁移服务 - 负责将内置模型从资源目录迁移到用户定义的存储目录
 */
export class ModelMigrationService {
  private static instance: ModelMigrationService;

  private constructor() {}

  public static getInstance(): ModelMigrationService {
    if (!ModelMigrationService.instance) {
      ModelMigrationService.instance = new ModelMigrationService();
    }
    return ModelMigrationService.instance;
  }

  /**
   * 获取内置模型的源目录
   */
  private getSourceDir(): string {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'models');
    } else {
      return path.join(app.getAppPath(), 'build', 'extraResources', 'models');
    }
  }


  /**
   * 向渲染进程广播迁移进度
   */
  private notifyProgress(message: string, silent = false): void {
    if (silent) return;
    BrowserWindow.getAllWindows().forEach(win => {
      win.webContents.send('llama/model-migration-progress', message);
    });
  }

  /**
   * 迁移所有内置模型到目标目录
   * @param baseTargetDir 基础存储目录 (MODEL_STORAGE_PATH)
   * @param silent 是否静默迁移（不发送进度事件到前端）
   * @param force 是否强制迁移（忽略 MODEL_MIGRATION_COMPLETED 标记）
   */
  async migrateModels(baseTargetDir: string, silent = false, force = false): Promise<{ success: boolean; error?: string }> {
    const configOrchestrator = ConfigOrchestrator.getInstance();
    const isCompleted = configOrchestrator.getValue<boolean>('MODEL_MIGRATION_COMPLETED');
    
    if (isCompleted && !force) {
      logger.info(LogCategory.LLAMA_SERVER, '模型迁移已完成，跳过');
      return { success: true };
    }

    const sourceDir = this.getSourceDir();
    return await this.performMigration(sourceDir, baseTargetDir, true, silent);
  }

  /**
   * 从旧目录迁移模型到新目录
   */
  async migrateFromOldPath(oldPath: string, newPath: string): Promise<{ success: boolean; error?: string }> {
    logger.info(LogCategory.LLAMA_SERVER, `开始从旧目录迁移模型: ${oldPath} -> ${newPath}`);

    // 1. 首先迁移内置模型 (优先级最高)
    const builtinResult = await this.performMigration(this.getSourceDir(), newPath, false, false);

    if (!builtinResult.success) {
      return builtinResult;
    }

    // 通知前端内置模型迁移完成，并告知剩余需要后台迁移的模型数量
    const entries = await fs.readdir(oldPath).catch(() => []);
    const modelDirs = entries.filter(e => e.startsWith('models--'));
    const builtinModelId = unifiedModelManager.getBuiltinModelId();
    const builtinDir = path.basename(unifiedModelManager.getModelDirectory(builtinModelId));
    const otherModelDirs = modelDirs.filter(d => d !== builtinDir);

    this.notifyProgress(`builtin-completed:${otherModelDirs.length}`);

    // 2. 扫描并迁移旧目录中的其他模型 (后台进行)
    this.startBackgroundMigration(oldPath, newPath, otherModelDirs).catch(err => {
      logger.error(LogCategory.LLAMA_SERVER, '后台模型迁移失败:', err);
    });

    return { success: true };
  }

  /**
   * 执行迁移核心逻辑
   */
  private async performMigration(sourceDir: string, targetDir: string, updateConfig: boolean, silent = false): Promise<{ success: boolean; error?: string }> {
    const builtinModelId = unifiedModelManager.getBuiltinModelId();
    const dirName = path.basename(unifiedModelManager.getModelDirectory(builtinModelId));
    const sourceDirPath = path.join(sourceDir, dirName);
    const targetDirPath = path.join(targetDir, dirName);

    logger.info(LogCategory.LLAMA_SERVER, `执行迁移: ${sourceDir} -> ${targetDir}`);
    // 不要在这里使用 t 函数，因为它是渲染进程的国际化工具，主进程应该直接发消息或使用主进程的 i18n
    this.notifyProgress('preparing', silent);

    try {
      await fs.ensureDir(targetDir);

      // 场景 1: 源位置已经是完整的 models--org--repo 目录结构
      if (await fs.pathExists(sourceDirPath)) {
        logger.info(LogCategory.LLAMA_SERVER, `发现预置目录，开始整体迁移: ${dirName}`);
        this.notifyProgress('migrating-builtin-dir', silent);
        await this.robustMoveOrCopy(sourceDirPath, targetDirPath);
      } 
      // 场景 2: 源位置是扁平的文件列表
      else {
        logger.info(LogCategory.LLAMA_SERVER, `未发现预置目录，尝试从扁平文件结构寻找内置模型并迁移到: ${dirName}`);

        const builtinConfig = unifiedModelManager.getBuiltinModelConfig();
        const filesInSource = await fs.readdir(sourceDir).catch(() => []);
        const ggufFiles = filesInSource.filter(f => f.toLowerCase().endsWith('.gguf'));

        if (ggufFiles.length > 0) {
          await fs.ensureDir(targetDirPath);

          // 寻找主模型文件：非 mmproj 的 .gguf 文件
          // 如果有多个，优先寻找包含 tag 的
          const tag = builtinModelId.includes(':') ? builtinModelId.split(':')[1] : '';
          const cleanTag = tag.replace(/^UD-/, '').toLowerCase();

          const mainModelFile = ggufFiles.find(f => {
            const lowerF = f.toLowerCase();
            return !lowerF.includes('mmproj') && (cleanTag ? lowerF.includes(cleanTag) : true);
          }) || ggufFiles.find(f => !f.toLowerCase().includes('mmproj'));

          if (mainModelFile) {
            const sourcePath = path.join(sourceDir, mainModelFile);
            const targetPath = path.join(targetDirPath, mainModelFile);
            logger.info(LogCategory.LLAMA_SERVER, `发现内置主模型文件: ${mainModelFile}`);
            this.notifyProgress(`migrating-builtin-file:${mainModelFile}`, silent);
            await this.robustMoveOrCopy(sourcePath, targetPath);
          }

          // 如果是多模态，寻找投影文件
          if (builtinConfig?.isMultiModal) {
            const mmprojFile = ggufFiles.find(f => f.toLowerCase().includes('mmproj'));
            if (mmprojFile) {
              const sourcePath = path.join(sourceDir, mmprojFile);
              const targetPath = path.join(targetDirPath, mmprojFile);
              logger.info(LogCategory.LLAMA_SERVER, `发现内置多模态投影文件: ${mmprojFile}`);
              this.notifyProgress(`migrating-builtin-file:${mmprojFile}`, silent);
              await this.robustMoveOrCopy(sourcePath, targetPath);
            }
          }
        } else {
          logger.warn(LogCategory.LLAMA_SERVER, `在源目录中未发现任何 GGUF 文件: ${sourceDir}`);
        }
      }

      if (updateConfig) {
        const configOrchestrator = ConfigOrchestrator.getInstance();
        await configOrchestrator.updateValue('SELECTED_MODEL_ID', builtinModelId);
        await configOrchestrator.updateValue('MODEL_MIGRATION_COMPLETED', true);
        
        // 核心修复：初始迁移完成后，发送完成通知以清除前端的 mask 状态
        this.notifyProgress('builtin-completed:0', silent);
      }

      return { success: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(LogCategory.LLAMA_SERVER, `迁移失败: ${msg}`, error);
      return { success: false, error: msg };
    }
  }

  /**
   * 后台迁移其他模型
   */
  private async startBackgroundMigration(oldPath: string, newPath: string, otherModelDirs: string[]): Promise<void> {
    try {
      const total = otherModelDirs.length;
      logger.info(LogCategory.LLAMA_SERVER, `发现 ${total} 个其他模型目录待迁移`);

      let count = 0;
      for (const dir of otherModelDirs) {
        const source = path.join(oldPath, dir);
        const target = path.join(newPath, dir);

        try {
          await this.robustMoveOrCopy(source, target);
          count++;
          const remaining = total - count;
          this.notifyProgress(`background-migration-success:${count}:${remaining}`);
          logger.info(LogCategory.LLAMA_SERVER, `后台迁移完成 (${count}/${total}): ${dir}`);
        } catch (e) {
          logger.error(LogCategory.LLAMA_SERVER, `后台迁移目录失败: ${dir}`, e);
        }
      }

      this.notifyProgress('migration-finished');
      logger.info(LogCategory.LLAMA_SERVER, '所有模型迁移任务完成');
    } catch (error) {
      logger.error(LogCategory.LLAMA_SERVER, '后台迁移失败:', error);
      this.notifyProgress('migration-error');
    }
  }

  /**
   * 强健的移动或复制逻辑 - 支持同盘秒移、异盘秒跳(同大小)与即时清理
   */
  private async robustMoveOrCopy(sourcePath: string, targetPath: string): Promise<void> {
    try {
      // 1. 基本检查
      if (!await fs.pathExists(sourcePath)) return;

      const builtinSourceDir = this.getSourceDir();
      const absSource = path.resolve(sourcePath);
      const absBuiltin = path.resolve(builtinSourceDir);

      // 安全锁：只有当源路径不在“系统内置模型目录”内时，才允许执行物理删除/移动
      const isDeletable = !absSource.startsWith(absBuiltin);

      // 2. 检查目标是否已存在且大小一致 (优化点：跳过冗余复制)
      if (await fs.pathExists(targetPath)) {
        const sourceStat = await fs.stat(sourcePath);
        const targetStat = await fs.stat(targetPath);

        if (sourceStat.size === targetStat.size) {
          logger.info(LogCategory.LLAMA_SERVER, `目标已存在且大小一致，跳过复制: ${path.basename(targetPath)}`);
          if (isDeletable) {
            await fs.remove(sourcePath);
            logger.debug(LogCategory.LLAMA_SERVER, `已立即清理冗余源项目: ${sourcePath}`);
          }
          return;
        }
      }

      // 3. 检查是否在同一个磁盘分区
      const sourceRoot = path.parse(absSource).root.toLowerCase();
      const targetRoot = path.parse(path.resolve(targetPath)).root.toLowerCase();
      const isSameDisk = sourceRoot === targetRoot;

      if (isSameDisk && isDeletable) {
        // 同盘移动 (秒移)
        logger.info(LogCategory.LLAMA_SERVER, `执行同盘秒移: ${path.basename(sourcePath)}`);
        await fs.move(sourcePath, targetPath, { overwrite: true });
      } else {
        // 异盘迁移或资源迁移：执行复制
        logger.info(LogCategory.LLAMA_SERVER, `执行复制迁移: ${sourcePath} -> ${targetPath}`);
        await fs.copy(sourcePath, targetPath, { overwrite: true });

        // 4. 异盘迁移验证并立即删除
        if (isDeletable) {
          const targetExists = await fs.pathExists(targetPath);
          if (targetExists) {
            const sourceStat = await fs.stat(sourcePath);
            const targetStat = await fs.stat(targetPath);

            if (sourceStat.size === targetStat.size) {
              await fs.remove(sourcePath);
              logger.debug(LogCategory.LLAMA_SERVER, `异盘迁移验证成功，已立即清理源目录: ${sourcePath}`);
            } else {
              throw new Error(`迁移后文件大小不匹配: ${sourceStat.size} != ${targetStat.size}`);
            }
          }
        }
      }
    } catch (error: any) {
      // 最终降级逻辑 (通常用于处理异盘移动权限不足等极端情况)
      logger.warn(LogCategory.LLAMA_SERVER, `操作失败 (${error.code || 'unknown'})，尝试降级复制重试: ${sourcePath}`);
      
      try {
        await fs.copy(sourcePath, targetPath, { overwrite: true });

        const builtinSourceDir = this.getSourceDir();
        const isDeletable = !path.resolve(sourcePath).startsWith(path.resolve(builtinSourceDir));

        if (isDeletable) {
          const sourceStat = await fs.stat(sourcePath);
          const targetStat = await fs.stat(targetPath);
          if (sourceStat.size === targetStat.size) {
            await fs.remove(sourcePath).catch(() => {});
          }
        }
      } catch (finalError) {
        logger.error(LogCategory.LLAMA_SERVER, '模型迁移彻底失败:', finalError);
        throw finalError;
      }
    }
  }
}

export const modelMigrationService = ModelMigrationService.getInstance();
