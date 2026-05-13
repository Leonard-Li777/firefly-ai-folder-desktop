import * as fs from 'fs-extra';
import * as path from 'path';
import * as unzipper from 'unzipper';

import { LogCategory, logger } from '@yonuc/shared';

import { THardwareAcceleration } from '@yonuc/types';
import { app } from 'electron';
import { exec, spawn } from 'child_process';
import { hardwareDetectionService } from '../system/hardware-detection-service';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Llama Engine Service - 管理 llama.cpp 引擎的运行时部署
 * 实现 docs/llama/llama-v2.md 中的动态解压逻辑
 */
export class LlamaEngineService {
  private static instance: LlamaEngineService;
  private readonly engineDir: string;
  private readonly successFlag: string;
  private readonly bundlesDir: string;
  private deploymentPromise: Promise<string> | null = null;
  
  /**
   * 受保护的文件列表，这些文件在同步和清理过程中不应被删除
   */
  private readonly PROTECTED_ITEMS = [
    '.success'
  ];

  private constructor() {
    // 部署到 userData/bin/llama-server
    this.engineDir = path.join(app.getPath('userData'), 'bin', 'llama-server');
    this.successFlag = path.join(this.engineDir, '.success');
    
    // 原始包位于 resources/bundles
    if (app.isPackaged) {
      this.bundlesDir = path.join(process.resourcesPath, 'bundles');
    } else {
      // 开发环境下，尝试多个可能的 bundles 路径以适配不同的启动方式
      const possiblePaths = [
        path.join(process.cwd(), 'apps/desktop/build/extraResources/bundles'),
        path.join(process.cwd(), 'build/extraResources/bundles'),
        path.join(__dirname, '../../../../build/extraResources/bundles')
      ];
      
      this.bundlesDir = possiblePaths.find(p => fs.existsSync(p)) || possiblePaths[0];
      logger.info(LogCategory.AI_SERVICE, `Llama 资源包目录 (开发模式): ${this.bundlesDir}`);
    }
  }

  static getInstance(): LlamaEngineService {
    if (!LlamaEngineService.instance) {
      LlamaEngineService.instance = new LlamaEngineService();
    }
    return LlamaEngineService.instance;
  }

  /**
   * 确保引擎已正确部署
   * @param force 是否强制重新部署
   */
  async isEngineReady(): Promise<boolean> {
    return await fs.pathExists(this.successFlag);
  }

  /**
   * 确保引擎已正确部署
   * @param force 是否强制重新部署
   */
  async ensureEngineDeployed(force = false): Promise<string> {
    // 如果已经有正在进行的部署，等待它完成
    if (this.deploymentPromise) {
      logger.debug(LogCategory.AI_SERVICE, '正在等待已启动的 Llama 引擎部署任务...');
      return this.deploymentPromise;
    }

    const { ConfigOrchestrator } = await import('../../config/config-orchestrator');
    const currentEngine = ConfigOrchestrator.getInstance().getValue<string>('AI_ENGINE');
    const acceleration = await hardwareDetectionService.getBestAccelerationTier();

    // 验证部署标志
    let needsRedeploy = force;
    if (!needsRedeploy && await fs.pathExists(this.successFlag)) {
      try {
        const flagContent = await fs.readJson(this.successFlag);
        // 核心检查：如果引擎类型、加速层级或二进制文件不存在，则需要重新部署
        if (flagContent.engine !== currentEngine || flagContent.acceleration !== acceleration) {
          logger.info(LogCategory.AI_SERVICE, `检测到引擎或硬件环境变更 (旧: ${flagContent.engine}/${flagContent.acceleration}, 新: ${currentEngine}/${acceleration})，将触发重新部署`);
          needsRedeploy = true;
        } else {
          // 进一步检查关键二进制文件是否存在
          const binaryPath = await this.getServerBinaryPath(currentEngine);
          if (!await fs.pathExists(binaryPath)) {
            logger.warn(LogCategory.AI_SERVICE, `关键二进制文件丢失: ${binaryPath}，触发重新部署`);
            needsRedeploy = true;
          }
        }
      } catch (e) {
        logger.warn(LogCategory.AI_SERVICE, '读取部署标志失败，将重新部署', e);
        needsRedeploy = true;
      }
    } else if (!await fs.pathExists(this.successFlag)) {
      needsRedeploy = true;
    }
    
    if (!needsRedeploy) {
      logger.info(LogCategory.AI_SERVICE, `Llama 引擎 (${currentEngine}) 已部署且验证通过`);
      return await this.getServerBinaryPath(currentEngine);
    }

    // 创建新的部署任务
    this.deploymentPromise = this.performDeployment(needsRedeploy);
    
    try {
      const result = await this.deploymentPromise;
      return result;
    } finally {
      this.deploymentPromise = null;
    }
  }

  /**
   * 执行实际的部署逻辑
   */
  private async performDeployment(force: boolean): Promise<string> {
    logger.info(LogCategory.AI_SERVICE, force ? '强制重新部署 Llama 引擎...' : '未检测到有效部署，开始部署 Llama 引擎...');

    // macOS 兼容性检查：Monterey (12.x) 及以下版本不支持带有最新 Accelerate 符号的二进制文件
    if (process.platform === 'darwin') {
      try {
        const { stdout } = await execAsync('sw_vers -productVersion');
        const version = stdout.trim();
        const majorVersion = parseInt(version.split('.')[0]);
        if (majorVersion < 13) {
          logger.warn(LogCategory.AI_SERVICE, `检测到 macOS 版本 ${version}。注意：当前引擎二进制文件针对 macOS 13+ 优化，在 12.x (Monterey) 上可能会因缺失 Accelerate 框架符号而导致启动失败。`);
        }
      } catch (e) {
        // 忽略检查失败
      }
    }

    try {
      // 1. 如果是 Windows，先尝试关闭可能运行的进程
      if (process.platform === 'win32') {
        try {
          await execAsync('taskkill /f /im llama-server.exe /t');
          await execAsync('taskkill /f /im llama-completion.exe /t');
          await execAsync('taskkill /f /im llamafile.exe /t');
          logger.info(LogCategory.AI_SERVICE, '已停止运行中的 Llama 进程 (server, completion, llamafile)');
          
          // 给系统一点时间释放文件句柄
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (e) {
          // 进程未运行或无法停止，忽略
        }
      }

      // 2. 确保目标目录存在且进行清理 (保留受保护的文件和 ZIP 资源)
      await fs.ensureDir(this.engineDir);
      const existingItems = await fs.readdir(this.engineDir).catch(() => []);
      for (const item of existingItems) {
        if (!this.PROTECTED_ITEMS.includes(item)) {
          const itemPath = path.join(this.engineDir, item);
          try {
            await this.retry(() => fs.remove(itemPath), 3, 500);
          } catch (err) {
            logger.warn(LogCategory.AI_SERVICE, `清理项目失败 (将尝试继续): ${itemPath}`, err);
          }
        }
      }

      // 3. 探测硬件并选择 Bundle
      const acceleration = await hardwareDetectionService.getBestAccelerationTier();
      const bundles = await this.resolveBundles(acceleration);

      logger.info(LogCategory.AI_SERVICE, `解析到的资源包列表: ${JSON.stringify(bundles)}`);

      if (bundles.length === 0) {
        throw new Error(`无法为加速层级 ${acceleration} 找到合适的资源包`);
      }

      // 4. 执行解压
      for (const bundleName of bundles) {
        const bundlePath = path.join(this.bundlesDir, bundleName);
        if (!(await fs.pathExists(bundlePath))) {
          logger.warn(LogCategory.AI_SERVICE, `跳过不存在的资源包: ${bundlePath}`);
          continue;
        }

        logger.info(LogCategory.AI_SERVICE, `正在部署资源包: ${bundleName}`);
        
        // 创建临时解压目录以进行打平处理。将临时目录移至 engineDir 外部，避免嵌套路径冲突
        // 使用随机后缀确保并发安全（虽然目前是顺序执行）并避开可能的权限缓存问题
        const randomSuffix = Math.random().toString(36).substring(2, 8);
        const tempExtractDir = path.join(app.getPath('temp'), `yonuc_ext_${bundleName.replace(/[^a-z0-9]/gi, '_')}_${randomSuffix}`);
        
        await fs.remove(tempExtractDir); 
        await fs.ensureDir(tempExtractDir);

        try {
          if (bundleName.toLowerCase().endsWith('.zip')) {
            await this.extractZip(bundlePath, tempExtractDir);
          } else if (bundleName.toLowerCase().endsWith('.tar.gz') || bundleName.toLowerCase().endsWith('.tgz')) {
            await this.extractTar(bundlePath, tempExtractDir);
          }

          // 验证解压结果
          if (!(await fs.pathExists(tempExtractDir))) {
            throw new Error(`解压失败: 临时目录 ${tempExtractDir} 不存在`);
          }
          
          let tempItems: string[] = [];
          try {
            tempItems = await fs.readdir(tempExtractDir);
          } catch (readdirErr: any) {
            logger.error(LogCategory.AI_SERVICE, `无法读取临时解压目录: ${tempExtractDir}`, readdirErr);
            throw new Error(`无法读取解压后的临时目录: ${readdirErr.message}`);
          }

          if (tempItems.length === 0) {
            logger.warn(LogCategory.AI_SERVICE, `警告: 解压后的临时目录为空: ${tempExtractDir}`);
          } else {
            logger.debug(LogCategory.AI_SERVICE, `临时目录 ${tempExtractDir} 包含 ${tempItems.length} 个项目`);
          }

          // 处理 llamafile 变体 (原始二进制文件部署与 GPU 驱动解压)
          const isLlamafile = bundleName.toLowerCase().includes('llamafile');
          if (isLlamafile) {
            const isCompressed = bundleName.toLowerCase().endsWith('.zip') || 
                               bundleName.toLowerCase().endsWith('.tar.gz') || 
                               bundleName.toLowerCase().endsWith('.tgz');

            // 如果是原始二进制文件（非压缩包），直接复制到目标目录并重命名
            if (!isCompressed) {
              const targetName = process.platform === 'win32' ? 'llamafile.exe' : 'llamafile';
              const targetPath = path.join(this.engineDir, targetName);
              logger.info(LogCategory.AI_SERVICE, `正在部署 llamafile 原始二进制文件: ${bundleName} -> ${targetName}`);
              await fs.copy(bundlePath, targetPath);
              if (process.platform !== 'win32') {
                await fs.chmod(targetPath, 0o755);
              }
            }

            // Windows 下特殊处理：llamafile 需要额外的 GPU 驱动支持
            if (process.platform === 'win32') {
              const driverPath = path.join(this.bundlesDir, 'llamafile-gpu-driver.zip');
              if (await fs.pathExists(driverPath)) {
                // 修正：确保解压到 %USERPROFILE%/.llamafile，这是 llamafile 默认寻找驱动的位置
                const homeDir = app.getPath('home');
                logger.info(LogCategory.AI_SERVICE, `发现 llamafile-gpu-driver.zip，准备解压到用户根目录: ${homeDir}`);
                await this.extractZip(driverPath, homeDir);
              }
            }

            // 如果是原始二进制文件且不是压缩包，我们已经完成了该 bundle 的处理
            // 如果是压缩包，需要继续执行下方的 moveAllFilesRecursively 以处理解压后的内容
            if (!isCompressed) {
              continue;
            }
          }
          // 递归查找并移动所有文件
          await this.moveAllFilesRecursively(tempExtractDir, this.engineDir);
        } catch (err) {
          logger.error(LogCategory.AI_SERVICE, `部署资源包 ${bundleName} 失败:`, err);
          throw err;
        } finally {
          await fs.remove(tempExtractDir);
        }
      }

      // 4.5. 日志记录当前部署的所有文件，方便调试
      const finalFiles = await fs.readdir(this.engineDir);
      logger.info(LogCategory.AI_SERVICE, `部署完成，目标目录文件列表: ${JSON.stringify(finalFiles)}`);

      // 4.6. 特殊逻辑：确保工具文件名正确 (特别是处理压缩包内文件名为原始版本号的情况)
      const targetLlamafileName = process.platform === 'win32' ? 'llamafile.exe' : 'llamafile';
      const targetLlamaServerName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
      const targetLlamaCliName = process.platform === 'win32' ? 'llama-cli.exe' : 'llama-cli';
      const targetLlamaCompletionName = process.platform === 'win32' ? 'llama-completion.exe' : 'llama-completion';
      
      // 再次读取目录以获取最新的文件列表
      const updatedFiles = await fs.readdir(this.engineDir);
      logger.info(LogCategory.AI_SERVICE, `标准化重命名开始，当前文件: ${JSON.stringify(updatedFiles)}`);

      for (const file of updatedFiles) {
        const filePath = path.join(this.engineDir, file);
        const lowerFile = file.toLowerCase();
        
        // 跳过目录和受保护的项目。使用 lstat 避免在虚拟机环境下跟随失效链接
        const itemStats = await fs.lstat(filePath);
        if (itemStats.isDirectory() || this.PROTECTED_ITEMS.includes(file)) continue;

        // 如果是 llamafile 变体且目标文件尚不存在
        if (lowerFile.includes('llamafile') && file !== targetLlamafileName) {
          const finalPath = path.join(this.engineDir, targetLlamafileName);
          if (!(await fs.pathExists(finalPath))) {
            if (!file.endsWith('.md') && !file.endsWith('.txt')) {
              logger.info(LogCategory.AI_SERVICE, `标准化 llamafile: ${file} -> ${targetLlamafileName}`);
              await fs.rename(filePath, finalPath);
              if (process.platform !== 'win32') await fs.chmod(finalPath, 0o755);
            }
          }
        }
        
        // 如果是 llama-server 变体
        if ((lowerFile.includes('llama-server') || lowerFile.includes('llama.cpp-server')) && file !== targetLlamaServerName) {
          const finalPath = path.join(this.engineDir, targetLlamaServerName);
          if (!(await fs.pathExists(finalPath))) {
            logger.info(LogCategory.AI_SERVICE, `标准化 llama-server: ${file} -> ${targetLlamaServerName}`);
            await fs.rename(filePath, finalPath);
            if (process.platform !== 'win32') await fs.chmod(finalPath, 0o755);
          }
        }

        // 如果是 llama-cli 变体
        if (lowerFile.includes('llama-cli') && file !== targetLlamaCliName) {
          const finalPath = path.join(this.engineDir, targetLlamaCliName);
          if (!(await fs.pathExists(finalPath))) {
            logger.info(LogCategory.AI_SERVICE, `标准化 llama-cli: ${file} -> ${targetLlamaCliName}`);
            await fs.rename(filePath, finalPath);
            if (process.platform !== 'win32') await fs.chmod(finalPath, 0o755);
          }
        }

        // 如果是 llama-completion 变体
        if (lowerFile.includes('llama-completion') && file !== targetLlamaCompletionName) {
          const finalPath = path.join(this.engineDir, targetLlamaCompletionName);
          if (!(await fs.pathExists(finalPath))) {
            logger.info(LogCategory.AI_SERVICE, `标准化 llama-completion: ${file} -> ${targetLlamaCompletionName}`);
            await fs.rename(filePath, finalPath);
            if (process.platform !== 'win32') await fs.chmod(finalPath, 0o755);
          }
        }
      }

      // 4.7. 权限加固：确保在非 Windows 平台上，所有标准命名的二进制文件都具有执行权限
      // 这是为了处理那些解压后文件名就已经正确（未触发重命名）的情况
      if (process.platform !== 'win32') {
        const criticalBinaries = [
          targetLlamafileName,
          targetLlamaServerName,
          targetLlamaCliName,
          targetLlamaCompletionName
        ];
        
        for (const binName of criticalBinaries) {
          const binPath = path.join(this.engineDir, binName);
          if (await fs.pathExists(binPath)) {
            try {
              const stats = await fs.lstat(binPath);
              // 如果是软链接，通常权限取决于目标，但我们在这里先确保不会因为 stat 失败而崩溃
              // 如果缺少执行权限 (0o111 是 --x--x--x)
              if (!(stats.mode & 0o111)) {
                logger.info(LogCategory.AI_SERVICE, `修复二进制文件执行权限: ${binName}`);
                await fs.chmod(binPath, 0o755);
              }
            } catch (err) {
              logger.warn(LogCategory.AI_SERVICE, `尝试设置 ${binName} 执行权限失败:`, err);
            }
          }
        }
      }

      // 5. 写入增强的成功标记
      const { ConfigOrchestrator } = await import('../../config/config-orchestrator');
      const engine = ConfigOrchestrator.getInstance().getValue('AI_ENGINE');
      
      await fs.writeJson(this.successFlag, {
        engine,
        deployedAt: new Date().toISOString(),
        acceleration,
        bundles,
        files: await fs.readdir(this.engineDir)
      }, { spaces: 2 });

      // 6. 清理冗余目录
      await this.cleanupEngineDir();

      // 7. 清理过时的原始资源包
      await this.cleanupOldBundles(bundles);

      logger.info(LogCategory.AI_SERVICE, 'Llama 引擎部署成功');
      return await this.getServerBinaryPath();
    } catch (error) {
      logger.error(LogCategory.AI_SERVICE, 'Llama 引擎部署失败:', error);
      throw error;
    }
  }

  /**
   * 递归移动目录下的所有文件到目标目录
   */
  private async moveAllFilesRecursively(srcDir: string, destBaseDir: string): Promise<void> {
    if (!(await fs.pathExists(srcDir))) {
      logger.warn(LogCategory.AI_SERVICE, `移动文件失败: 源目录不存在: ${srcDir}`);
      return;
    }

    const items = await fs.readdir(srcDir);
    for (const item of items) {
      const srcPath = path.join(srcDir, item);
      
      // 增加二次验证：处理由于杀毒软件或并发操作导致的 ENOENT
      if (!(await fs.pathExists(srcPath))) {
        logger.warn(LogCategory.AI_SERVICE, `跳过不存在的项目 (可能已被其他逻辑移动或删除): ${srcPath}`);
        continue;
      }

      // 使用 lstat 而不是 stat，这样如果是软链接，我们获取的是链接本身的信息，而不是它指向的目标
      const stats = await fs.lstat(srcPath);
      
      if (stats.isDirectory()) {
        await this.moveAllFilesRecursively(srcPath, destBaseDir);
      } else {
        // 如果是文件或软链接，打平移动到根目录
        const destPath = path.join(destBaseDir, item);
        
        // 特殊处理：如果是 Windows 下的 llamafile（无后缀），尝试直接加上 .exe
        let finalDestPath = destPath;
        if (process.platform === 'win32' && item.toLowerCase() === 'llamafile') {
          finalDestPath = destPath + '.exe';
        }

        // 使用重试机制处理 Windows 下的文件锁定或延迟释放
        await this.retry(async () => {
          // 再次确认源文件存在 (处理并发重试时的竞争)
          if (!(await fs.pathExists(srcPath))) return;

          try {
            // 检查目标是否存在，如果存在则先删除，避免 rename 冲突
            if (await fs.pathExists(finalDestPath)) {
              await fs.remove(finalDestPath);
            }

            // 优先使用 rename，它是原子的
            await fs.rename(srcPath, finalDestPath);
          } catch (renameErr: any) {
            // 如果是跨设备移动 (EXDEV)、文件锁定 (EACCES/EBUSY) 或目标目录缺失 (ENOENT)，fallback 到 fs.move
            // fs.move 更健壮，会自动处理跨设备复制和创建必要的中间目录
            if (renameErr.code === 'EXDEV' || renameErr.code === 'EACCES' || renameErr.code === 'EBUSY' || renameErr.code === 'ENOENT') {
              if (stats.isSymbolicLink()) {
                const linkTarget = await fs.readlink(srcPath);
                await fs.remove(finalDestPath);
                await fs.symlink(linkTarget, finalDestPath);
                await fs.remove(srcPath);
              } else {
                await fs.move(srcPath, finalDestPath, { overwrite: true });
              }
            } else {
              throw renameErr;
            }
          }
        }, 3, 500);
      }
    }
  }

  /**
   * 清理引擎目录下的空目录和非必要目录
   */
  private async cleanupEngineDir(): Promise<void> {
    const items = await fs.readdir(this.engineDir);
    for (const item of items) {
      // 如果是受保护的项目，则跳过
      if (this.PROTECTED_ITEMS.includes(item)) {
        continue;
      }
      
      const itemPath = path.join(this.engineDir, item);
      const stats = await fs.lstat(itemPath);
      
      if (stats.isDirectory()) {
        // 清理所有非受保护的子目录，因为二进制文件应该都已被标准化移动到根目录
        logger.debug(LogCategory.AI_SERVICE, `清理冗余引擎子目录: ${item}`);
        await fs.remove(itemPath);
      }
    }
  }

  /**
   * 获取服务器二进制文件路径 (llama-server 或 llamafile)
   * @param preferredEngine 首选引擎名称 ('llama.cpp' 或 'llamafile')
   */
  async getServerBinaryPath(preferredEngine?: string): Promise<string> {
    const llamaServerName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
    const llamafileName = process.platform === 'win32' ? 'llamafile.exe' : 'llamafile';

    const llamaServerPath = path.join(this.engineDir, llamaServerName);
    const llamafilePath = path.join(this.engineDir, llamafileName);

    // 如果指定了首选引擎，优先检查它
    if (preferredEngine === 'llamafile') {
      if (await fs.pathExists(llamafilePath)) {
        logger.debug(LogCategory.AI_SERVICE, `找到首选 Llamafile 路径: ${llamafilePath}`);
        return llamafilePath;
      }
    } else if (preferredEngine === 'llama.cpp') {
      if (await fs.pathExists(llamaServerPath)) {
        logger.debug(LogCategory.AI_SERVICE, `找到首选 Llama Server 路径: ${llamaServerPath}`);
        return llamaServerPath;
      }
    }

    // 如果没指定或首选不存在，按默认优先级尝试
    if (await fs.pathExists(llamaServerPath)) {
      logger.debug(LogCategory.AI_SERVICE, `通过默认优先级找到 Llama Server 路径: ${llamaServerPath}`);
      return llamaServerPath;
    }
    if (await fs.pathExists(llamafilePath)) {
      logger.debug(LogCategory.AI_SERVICE, `通过默认优先级找到 Llamafile 路径: ${llamafilePath}`);
      return llamafilePath;
    }

    throw new Error('未找到 Llama 引擎可执行文件，请检查部署是否完整');
  }

  /**
   * 获取命令行工具路径 (llama-cli)
   * 用于模型拉取 (-hf) 等操作
   */
  getCliBinaryPath(): string {
    const exeName = process.platform === 'win32' ? 'llama-cli.exe' : 'llama-cli';
    const cliPath = path.join(this.engineDir, exeName);
    logger.debug(LogCategory.AI_SERVICE, `获取 Llama CLI 路径: ${cliPath}`);
    return cliPath;
  }

  /**
   * 获取补全工具路径 (llama-completion)
   * 用于不带会话的模型下载 (-hf ... --no-conversation)
   * 如果找不到独立的 llama-completion，则尝试回退到 llama-server
   */
  getCompletionBinaryPath(): string {
    const completionName = process.platform === 'win32' ? 'llama-completion.exe' : 'llama-completion';
    const serverName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
    
    const completionPath = path.join(this.engineDir, completionName);
    const serverPath = path.join(this.engineDir, serverName);

    if (fs.existsSync(completionPath)) {
      logger.debug(LogCategory.AI_SERVICE, `获取 Llama Completion 路径: ${completionPath}`);
      return completionPath;
    }

    if (fs.existsSync(serverPath)) {
      logger.debug(LogCategory.AI_SERVICE, `未找到 llama-completion，回退到 llama-server: ${serverPath}`);
      return serverPath;
    }

    logger.warn(LogCategory.AI_SERVICE, '未找到 llama-completion 或 llama-server');
    return completionPath; // 默认返回，由外部处理 ENOENT
  }

  /**
   * 获取引擎目录路径 (用于 PATH 注入)
   */
  getEngineDir(): string {
    return this.engineDir;
  }


  /**
   * 获取真实的硬件架构 (处理 macOS Rosetta 2 情况)
   */
  private async getRealArch(): Promise<string> {
    const arch = process.arch;
    if (process.platform === 'darwin' && arch === 'x64') {
      try {
        // 如果在 macOS x64 上运行，检查是否是 Apple Silicon (Rosetta 2)
        const { stdout } = await execAsync('sysctl -n hw.optional.arm64', { windowsHide: true });
        if (stdout.trim() === '1') {
          return 'arm64';
        }
      } catch (e) {
        // 忽略错误，回退到 process.arch
      }
    }
    return arch;
  }

  /**
   * 解析需要解压的包名
   */
  private async resolveBundles(acceleration: THardwareAcceleration): Promise<string[]> {
    const { ConfigOrchestrator } = await import('../../config/config-orchestrator');
    const engine = ConfigOrchestrator.getInstance().getValue('AI_ENGINE');
    
    const platform = process.platform;
    const arch = await this.getRealArch(); // 使用真实架构检测
    
    // 扫描 bundles 目录
    const allBundles = await fs.readdir(this.bundlesDir).catch(() => [] as string[]);
    
    // 助手函数：按版本号（bXXXX）排序，确保最新的包被优先选择
    const findLatestBundle = (pattern: RegExp) => {
      return allBundles
        .filter(b => pattern.test(b))
        .sort((a, b) => {
          const matchA = a.match(/b(\d+)/i);
          const matchB = b.match(/b(\d+)/i);
          if (matchA && matchB) {
            return parseInt(matchB[1]) - parseInt(matchA[1]); // 降序排序
          }
          return b.localeCompare(a); // 兜底：字母序降序
        })[0];
    };

    const bundles: string[] = [];

    // --- 1. Llama.cpp 资源包逻辑 (仅在引擎为 llama.cpp 时执行) ---
    if (engine === 'llama.cpp') {
      // Windows
      if (platform === 'win32') {
        if (acceleration === 'cuda') {
          // 放宽 CUDA 版本匹配，以支持用户自行更新的包 (如 12.6, 12.x)
          const main = findLatestBundle(/llama-.*-bin-win-cuda-12\.4-x64\.zip/i);
          const runtime = findLatestBundle(/cudart-llama-bin-win-cuda-12\.4-x64\.zip/i);
          
          if (main) {
            bundles.push(main);
            logger.info(LogCategory.AI_SERVICE, `选中 Windows CUDA 主包: ${main}`);
          }
          if (runtime) {
            bundles.push(runtime);
            logger.info(LogCategory.AI_SERVICE, `选中 Windows CUDA 运行时包: ${runtime}`);
          }
        } else if (acceleration === 'vulkan') {
          const bundle = findLatestBundle(/llama-.*-bin-win-vulkan-x64\.zip/i);
          if (bundle) bundles.push(bundle);
        } else {
          // CPU Fallback
          // 尝试检测真实的 Windows 架构，即使当前进程是 x64 仿真模式
          const isRealArm64 = arch === 'arm64' || 
                             process.env['PROCESSOR_ARCHITECTURE'] === 'ARM64' || 
                             process.env['PROCESSOR_ARCHITEW6432'] === 'ARM64';
          
          const winCpuSuffix = isRealArm64 ? 'cpu-arm64' : 'cpu-x64';
          const cpu = findLatestBundle(new RegExp(`llama-.*-bin-win-${winCpuSuffix}\\.zip`, 'i')) ||
                      findLatestBundle(/llama-.*-bin-win-avx2-x64\.zip/i) ||
                      findLatestBundle(/llama-.*-bin-win-x64\.zip/i);
          if (cpu) bundles.push(cpu);
        }
      }

      // macOS
      if (platform === 'darwin') {
        const suffix = arch === 'arm64' ? 'macos-arm64' : 'macos-x64';
        const bundle = findLatestBundle(new RegExp(`llama-.*-bin-${suffix}\\.tar\\.gz`, 'i')) ||
                       findLatestBundle(new RegExp(`llama-.*-bin-${suffix}\\.zip`, 'i'));
        if (bundle) bundles.push(bundle);
      }

      // Linux
      if (platform === 'linux') {
        let found = false;
        
        // 1. 尝试加速版 (Vulkan)
        if (acceleration === 'vulkan') {
          const suffix = arch === 'arm64' ? 'ubuntu-vulkan-arm64' : 'ubuntu-vulkan-x64';
          const bundle = findLatestBundle(new RegExp(`llama-.*-bin-${suffix}\\.tar\\.gz`, 'i'));
          if (bundle) {
            bundles.push(bundle);
            found = true;
          }
        }
        
        // 2. 尝试 CPU 兜底或直接使用 CPU 版
        if (!found) {
          const suffix = arch === 'arm64' ? 'ubuntu-arm64' : 'ubuntu-x64';
          const bundle = findLatestBundle(new RegExp(`llama-.*-bin-${suffix}\\.tar\\.gz`, 'i')) ||
                         findLatestBundle(new RegExp(`llama-.*-bin-linux-${arch}\\.tar\\.gz`, 'i')) || // 兼容极旧命名
                         findLatestBundle(new RegExp(`llama-.*-bin-ubuntu-${arch}\\.tar\\.gz`, 'i'));  // 兼容其他可能命名
          if (bundle) {
            bundles.push(bundle);
          }
        }
      }
    }

    // --- 2. Llamafile 资源包逻辑 ---
    // 在 llamafile 模式下，我们需要依赖独立的 llama-completion 进行模型下载
    if (engine === 'llamafile') {
      const completionBundle = findLatestBundle(new RegExp(`llama-completion-${platform}.*\\.zip`, 'i'));
      if (completionBundle) {
        logger.info(LogCategory.AI_SERVICE, `找到 llamafile 模式依赖的补全包: ${completionBundle}`);
        bundles.push(completionBundle);
      }
    }

    // 寻找 llamafile 主程序包
    if (engine === 'llamafile' || engine === 'auto') {
      const llamafile = findLatestBundle(/llamafile-(?!gpu-driver).*(\.zip|\.exe)?$/i);
      if (llamafile) {
        bundles.push(llamafile);
      }
    }

    return bundles;
  }

  /**
   * 使用 unzipper 解压 ZIP
   */
  private async extractZip(zipPath: string, destDir: string): Promise<void> {
    logger.info(LogCategory.AI_SERVICE, `正在解压 (unzipper.Open.file): ${zipPath}`);
    const directory = await unzipper.Open.file(zipPath);

    // 手动提取以处理覆盖情况，避免 directory.extract 潜在的问题
    for (const file of directory.files) {
      const targetPath = path.join(destDir, file.path);

      // 防止 zip slip
      if (!targetPath.startsWith(path.normalize(destDir))) {
        continue;
      }

      if (file.type === 'Directory') {
        await fs.ensureDir(targetPath);
      } else {
        await fs.ensureDir(path.dirname(targetPath));

        // 如果文件存在并且大小一致，我们可选择跳过或直接覆盖。这里我们直接覆盖以确保完整性，
        // 或者简单判断存在性（可根据需要优化）。为避免冲突，使用 pipe + createWriteStream 强制覆盖。
        await new Promise<void>((resolve, reject) => {
          file.stream()
            .pipe(fs.createWriteStream(targetPath))
            .on('error', reject)
            .on('finish', resolve);
        });
      }
    }

    logger.info(LogCategory.AI_SERVICE, `解压完成: ${zipPath}`);
  }

  /**
   * 使用原生 tar 命令解压
   */
  private async extractTar(tarPath: string, destDir: string): Promise<void> {
    await fs.ensureDir(destDir);
    
    // 稳健性增强：在 Unix 系统下，如果直接 spawn('tar') 失败，尝试使用绝对路径
    // 这种情况通常发生在 Electron 应用未正确继承用户 PATH 时
    const tarCmd = process.platform === 'win32' ? 'tar' : await this.findTarExecutable();
    
    // --strip-components=1 会跳过压缩包内的顶层目录（如 llama-b9113），直接将内容解压到 destDir
    // 使用 -C 显式指定目标目录，这在处理包含空格的路径时通常比仅依赖 cwd 更稳健
    // --no-same-owner 增加在虚拟机或特殊权限环境下的稳健性
    const args = ['-xzf', tarPath, '-C', destDir, '--strip-components', '1', '--no-same-owner'];

    logger.debug(LogCategory.AI_SERVICE, `正在执行 tar 解压: ${tarCmd} ${args.join(' ')} (cwd: ${destDir})`);

    // 使用 spawn 替代 exec 以更安全地处理路径中的空格，并通过 cwd 避开 macOS tar -C 的潜在 Bug
    return new Promise((resolve, reject) => {
      // COPYFILE_DISABLE=1 防止 macOS tar 尝试处理和还原可能导致权限冲突的扩展属性 (._ 文件)
      const child = spawn(tarCmd, args, {
        cwd: destDir, // 双重保险：同时设置 cwd
        env: { ...process.env, COPYFILE_DISABLE: '1' },
        windowsHide: true
      });

      let stderr = '';
      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          logger.error(LogCategory.AI_SERVICE, `tar 提取失败 (退出代码 ${code}): ${stderr}`);
          reject(new Error(`Tar 部署失败: ${stderr}`));
        }
      });

      child.on('error', (err: any) => {
        if (err.code === 'ENOENT') {
          logger.error(LogCategory.AI_SERVICE, `无法找到 tar 可执行文件: ${tarCmd}. PATH: ${process.env.PATH}`);
          reject(new Error(`系统缺少 tar 命令，无法部署引擎资源。请确保系统已安装 tar 且在 PATH 中。具体错误: ${err.message}`));
        } else {
          reject(err);
        }
      });
    });
  }

  /**
   * 在 Unix 系统下尝试寻找 tar 可执行文件
   */
  private async findTarExecutable(): Promise<string> {
    // 默认先尝试直接使用 'tar'，依赖系统的 PATH 查找
    const defaultCmd = 'tar';
    
    // 如果是 Windows，直接返回 tar (现代 Windows 自带 tar)
    if (process.platform === 'win32') return defaultCmd;

    // 检查常见的标准路径，增加 Electron 环境下的稳健性
    const standardPaths = ['/usr/bin/tar', '/bin/tar', '/usr/local/bin/tar'];
    for (const p of standardPaths) {
      if (await fs.pathExists(p)) {
        return p;
      }
    }

    return defaultCmd;
  }

  /**
   * 解析模型文件的实际物理路径
   * @param modelId 模型 ID
   * @param type 寻找的文件类型: 'model' (主模型) 或 'projector' (多模态投射器)
   */
  async resolveModelPath(modelId: string, type: 'model' | 'projector' = 'model'): Promise<string | null> {
    try {
      const { unifiedModelManager } = await import('./unified-model-manager');
      const resolution = await unifiedModelManager.resolveModelPaths(modelId);
      
      if (!resolution) return null;

      return type === 'model' ? resolution.modelPath : resolution.mmprojPath || null;
    } catch (error) {
      logger.error(LogCategory.AI_SERVICE, `解析模型路径失败: ${modelId}`, error);
      return null;
    }
  }

  /**
   * 具有重试机制的异步执行函数
   */
  private async retry<T>(fn: () => Promise<T>, retries = 3, delay = 500): Promise<T> {
    let lastError: any;
    for (let i = 0; i < retries; i++) {
      try {
        return await fn();
      } catch (err: any) {
        lastError = err;
        // 只有特定的错误才需要重试 (如文件锁定、正在释放中)
        const isLockError = err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'ENOENT';
        if (isLockError && i < retries - 1) {
          logger.debug(LogCategory.AI_SERVICE, `文件操作暂时失败 (尝试 ${i + 1}/${retries}): ${err.code}. 正在重试...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  /**
   * 清理已部署版本之外的旧资源包
   */
  private async cleanupOldBundles(deployedBundles: string[]): Promise<void> {
    try {
      // 只有在开发模式或非打包状态下才尝试清理，避免在只读 resources 目录下报错
      if (app.isPackaged) return;

      const allFiles = await fs.readdir(this.bundlesDir).catch(() => []);
      
      for (const file of allFiles) {
        // 如果是刚刚部署的包，保留
        if (deployedBundles.includes(file)) continue;

        // 只清理符合 Llama 命名规范的包
        const isEngineBundle = /llama-.*-bin-.*\.zip/i.test(file) || 
                              /cudart-llama-bin-.*\.zip/i.test(file) ||
                              /llama-.*-bin-.*\.tar\.gz/i.test(file);
        
        if (!isEngineBundle) continue;

        // 进一步判断：如果该包的版本号低于当前部署的版本号，则删除
        const matchFile = file.match(/b(\d+)/i);
        if (matchFile) {
          const fileVersion = parseInt(matchFile[1]);
          const shouldDelete = deployedBundles.some(deployed => {
            const matchDeployed = deployed.match(/b(\d+)/i);
            if (matchDeployed) {
              const deployedVersion = parseInt(matchDeployed[1]);
              
              // 简单判断：如果架构后缀相似且版本号更低，则删除
              // 例如：llama-b9090-bin-win-cuda-12.4-x64.zip vs llama-b9113-bin-win-cuda-12.4-x64.zip
              const fileType = file.includes('cudart') ? 'runtime' : 'main';
              const deployedType = deployed.includes('cudart') ? 'runtime' : 'main';
              
              if (fileType === deployedType && deployedVersion > fileVersion) {
                return true;
              }
            }
            return false;
          });

          if (shouldDelete) {
            logger.info(LogCategory.AI_SERVICE, `正在清理旧版资源包: ${file}`);
            await fs.remove(path.join(this.bundlesDir, file)).catch(() => {});
          }
        }
      }
    } catch (e) {
      logger.warn(LogCategory.AI_SERVICE, '自动清理旧资源包失败:', e);
    }
  }

}

export const llamaEngineService = LlamaEngineService.getInstance();
