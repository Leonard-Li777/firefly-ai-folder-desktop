/**
 * File Permission Manager - 文件权限管理服务
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { calculateFileFingerprint as calculateFileFingerprintCore } from '@yonuc/core-engine/utils/file-fingerprint';
import { promisify } from 'util';
import fixPath from 'fix-path';
import { logger, LogCategory } from '@yonuc/shared';
import {
  IFilePermissionManager,
  IFileValidationResult
} from '@yonuc/types';
import { t } from '@app/languages';

// 在 macOS 和 Linux 上修复 PATH 环境变量
if (process.platform !== 'win32') {
  try {
    const fixPathFunc = typeof fixPath === 'function' ? fixPath : (fixPath as any).default;
    if (typeof fixPathFunc === 'function') {
      fixPathFunc();
    }
  } catch (e) {
    console.error('Failed to fix PATH in FilePermissionManager:', e);
  }
}

const execAsync = promisify(exec);

/**
 * 文件权限管理器实现
 */
export class FilePermissionManager implements IFilePermissionManager {

  /**
   * 设置文件可执行权限
   */
  async setExecutablePermission(filePath: string): Promise<void> {
    const platform = process.platform;

    // Windows系统不需要设置权限
    if (platform === 'win32') {
      return;
    }

    try {
      // 检查文件是否存在
      await fs.access(filePath);

      // 设置权限为755 (rwxr-xr-x)
      await fs.chmod(filePath, 0o755);

      logger.info(LogCategory.FILE_PERMISSION_MANAGER, `已设置可执行权限: ${filePath}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(t('设置可执行权限失败 {filePath}: {error}', { filePath, error: errorMessage }))
    }
  }

  /**
   * 检查文件权限
   */
  async checkPermissions(filePath: string): Promise<{
    readable: boolean;
    writable: boolean;
    executable: boolean;
  }> {
    let readable = false;
    let writable = false;
    let executable = false;

    try {
      // 检查读权限
      await fs.access(filePath, fs.constants.R_OK);
      readable = true;
    } catch {
      // 无读权限
    }

    try {
      // 检查写权限
      await fs.access(filePath, fs.constants.W_OK);
      writable = true;
    } catch {
      // 无写权限
    }

    try {
      // 检查执行权限
      await fs.access(filePath, fs.constants.X_OK);
      executable = true;
    } catch {
      // 无执行权限
    }

    return { readable, writable, executable };
  }

  /**
   * 验证二进制文件
   */
  async validateBinaryFile(filePath: string, expectedHash?: string): Promise<IFileValidationResult> {
    const result: IFileValidationResult = {
      isValid: false,
      exists: false,
      executable: false,
      size: 0,
      type: 'unknown',
      errors: [],
      warnings: []
    };

    try {
      // 检查文件是否存在
      const stats = await fs.stat(filePath);
      result.exists = true;
      result.size = stats.size;

      if (stats.isFile()) {
        result.type = 'file';
      } else if (stats.isDirectory()) {
        result.type = 'directory';
      }

      // 检查文件大小
      if (result.type === 'file') {
        if (stats.size === 0) {
          result.errors.push(t('文件大小为0'));
        } else if (stats.size < 1024 * 1024) { // 小于1MB
          result.warnings.push(t('文件大小可能过小，可能不是有效的二进制文件'));
        }
      }

      // 检查权限
      const permissions = await this.checkPermissions(filePath);
      result.executable = permissions.executable;

      if (!permissions.readable) {
        result.errors.push(t('文件不可读'));
      }

      if (!permissions.executable && process.platform !== 'win32') {
        result.warnings.push(t('文件不可执行，需要设置权限'));
      }

      // 验证文件哈希（如果提供了期望值）
      if (expectedHash && result.type === 'file') {
        try {
          const actualHash = await this.calculateFileFingerprint(filePath);
          result.hash = actualHash;

          if (actualHash !== expectedHash) {
            result.errors.push(t('文件哈希不匹配，期望: {expectedHash}, 实际: {actualHash}', { expectedHash, actualHash }));
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          result.warnings.push(t('无法计算文件哈希: {error}', { error: errorMessage }));
        }
      }

      // 平台特定验证
      if (process.platform !== 'win32') {
        await this.validateUnixBinary(filePath, result);
      } else {
        await this.validateWindowsBinary(filePath, result);
      }

      // 判断整体有效性
      result.isValid = result.exists && result.errors.length === 0;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      result.errors.push(t('文件验证失败: {error}', { error: errorMessage }));
    }

    return result;
  }

  /**
   * 验证Unix系统二进制文件
   */
  private async validateUnixBinary(filePath: string, result: IFileValidationResult): Promise<void> {
    try {
      // 使用file命令检查文件类型
      const { stdout } = await execAsync(`file "${filePath}"`);
      const fileType = stdout.toLowerCase();

      if (fileType.includes('executable') || fileType.includes('elf') || fileType.includes('mach-o')) {
        // 是可执行文件
        if (!result.executable) {
          result.warnings.push(t('检测到可执行文件但缺少执行权限'));
        }
      } else if (fileType.includes('directory')) {
        // 是目录，检查是否包含可执行文件
        try {
          const files = await fs.readdir(filePath);
          const hasExecutable = files.some(file =>
            file.includes('llama') || file.includes('server') || !file.includes('.')
          );

          if (!hasExecutable) {
            result.warnings.push(t('目录中未找到明显的可执行文件'));
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          result.warnings.push(t('无法读取目录内容: {error}', { error: errorMessage }));
        }
      } else {
        result.warnings.push(t('文件类型可能不正确: {fileType}', { fileType }));
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      result.warnings.push(t('无法检查文件类型: {error}', { error: errorMessage }));
    }
  }

  /**
   * 验证Windows系统二进制文件
   */
  private async validateWindowsBinary(filePath: string, result: IFileValidationResult): Promise<void> {
    try {
      if (result.type === 'file') {
        const ext = path.extname(filePath).toLowerCase();

        if (ext === '.exe') {
          // 是Windows可执行文件
          result.executable = true;
        } else if (ext === '') {
          // 无扩展名，可能是Unix风格的可执行文件
          result.warnings.push(t('Windows系统上的无扩展名文件，可能需要.exe扩展名'));
        }
      } else if (result.type === 'directory') {
        // 检查目录中是否有.exe文件
        try {
          const files = await fs.readdir(filePath);
          const hasExe = files.some(file =>
            file.toLowerCase().endsWith('.exe') &&
            (file.includes('llama') || file.includes('server'))
          );

          if (!hasExe) {
            result.warnings.push(t('目录中未找到.exe可执行文件'));
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          result.warnings.push(t('无法读取目录内容: {error}', { error: errorMessage }));
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      result.warnings.push(t('Windows文件验证失败: {error}', { error: errorMessage }));
    }
  }

  /**
   * 计算文件哈希
   * 使用统一的 core-engine 实现 (HMAC-SHA256 采样算法)
   */
  async calculateFileFingerprint(filePath: string): Promise<string> {
    return calculateFileFingerprintCore(filePath);
  }

  /**
   * 修复文件权限
   */
  async repairPermissions(filePath: string): Promise<void> {
    const platform = process.platform;

    // Windows系统不需要修复权限
    if (platform === 'win32') {
      return;
    }

    try {
      const stats = await fs.stat(filePath);

      if (stats.isFile()) {
        // 文件设置为755权限
        await fs.chmod(filePath, 0o755);
        logger.info(LogCategory.FILE_PERMISSION_MANAGER, `已修复文件权限: ${filePath}`);
      } else if (stats.isDirectory()) {
        // 目录设置为755权限
        await fs.chmod(filePath, 0o755);

        // 递归修复目录中的可执行文件权限
        const files = await fs.readdir(filePath);

        for (const file of files) {
          const fullPath = path.join(filePath, file);
          const fileStats = await fs.stat(fullPath);

          if (fileStats.isFile()) {
            // 检查是否可能是可执行文件
            const ext = path.extname(file).toLowerCase();
            const hasNoExt = ext === '';
            const isExecutableName = file.includes('llama') || file.includes('server');

            if (hasNoExt || isExecutableName) {
              await fs.chmod(fullPath, 0o755);
              logger.info(LogCategory.FILE_PERMISSION_MANAGER, `已修复可执行文件权限: ${fullPath}`);
            }
          }
        }

        logger.info(LogCategory.FILE_PERMISSION_MANAGER, `已修复目录权限: ${filePath}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(t('修复文件权限失败 {}: {}', [filePath, errorMessage]));
    }
  }

  /**
   * 批量验证文件
   */
  async validateFiles(filePaths: string[]): Promise<Map<string, IFileValidationResult>> {
    const results = new Map<string, IFileValidationResult>();

    // 并行验证所有文件
    const validationPromises = filePaths.map(async (filePath) => {
      try {
        const result = await this.validateBinaryFile(filePath);
        results.set(filePath, result);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        results.set(filePath, {
          isValid: false,
          exists: false,
          executable: false,
          size: 0,
          type: 'unknown',
          errors: [t('验证失败: {error}', { error: errorMessage })],
          warnings: []
        });
      }
    });

    await Promise.all(validationPromises);
    return results;
  }

  /**
   * 获取文件的详细信息
   */
  async getFileInfo(filePath: string): Promise<{
    path: string;
    name: string;
    size: number;
    type: string;
    permissions: string;
    lastModified: Date;
    isExecutable: boolean;
  }> {
    try {
      const stats = await fs.stat(filePath);
      const permissions = await this.checkPermissions(filePath);

      return {
        path: filePath,
        name: path.basename(filePath),
        size: stats.size,
        type: stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : 'unknown',
        permissions: this.formatPermissions(stats.mode),
        lastModified: stats.mtime,
        isExecutable: permissions.executable
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(t('获取文件信息失败: {error}', { error: errorMessage }));
    }
  }

  /**
   * 格式化权限信息
   */
  private formatPermissions(mode: number): string {
    if (process.platform === 'win32') {
      return t('Windows权限');
    }

    const permissions = [];

    // 所有者权限
    permissions.push((mode & 0o400) ? 'r' : '-');
    permissions.push((mode & 0o200) ? 'w' : '-');
    permissions.push((mode & 0o100) ? 'x' : '-');

    // 组权限
    permissions.push((mode & 0o040) ? 'r' : '-');
    permissions.push((mode & 0o020) ? 'w' : '-');
    permissions.push((mode & 0o010) ? 'x' : '-');

    // 其他用户权限
    permissions.push((mode & 0o004) ? 'r' : '-');
    permissions.push((mode & 0o002) ? 'w' : '-');
    permissions.push((mode & 0o001) ? 'x' : '-');

    return permissions.join('');
  }

  /**
   * 创建目录结构
   */
  async ensureDirectoryStructure(basePath: string): Promise<void> {
    try {
      await fs.mkdir(basePath, { recursive: true });

      // 设置目录权限
      if (process.platform !== 'win32') {
        await fs.chmod(basePath, 0o755);
      }

      logger.info(LogCategory.FILE_PERMISSION_MANAGER, `已创建目录结构: ${basePath}`);
    } catch (error) {
      throw new Error(t('创建目录结构失败: ', { error }));
    }
  }
}

/**
 * 单例实例
 */
export const filePermissionManager = new FilePermissionManager();
