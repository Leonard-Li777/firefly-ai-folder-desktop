import { BrowserWindow, app, webContents } from 'electron';
import type { DownloadProgressEvent, DownloadTaskSummary } from '@yonuc/types';
import { LogCategory, logger } from '@yonuc/shared';

import { ConfigOrchestrator } from '../../config/config-orchestrator';
import EventEmitter from 'events';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'child_process';
import { t } from '@app/languages';
import { unifiedModelManager } from '../llama/unified-model-manager';
import { LlamaEngineService } from '../llama/llama-engine-service';

/**
 * 下载任务状态
 */
export enum DownloadStatus {
  PENDING = 'pending',
  DOWNLOADING = 'downloading',
  RETRYING = 'retrying',
  COMPLETED = 'completed',
  ERROR = 'error',
  CANCELLED = 'canceled'
}

import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);

/**
 * 统一下载管理器 - 负责调度引擎拉取模型 (Ollama Pull / llama-cli -hf)
 */
export class ModelDownloadManager extends EventEmitter {
  private static instance: ModelDownloadManager;
  private activeProcesses = new Map<string, { child: any, lastPayload: any, earlyCompleted?: boolean }>(); // taskId -> { child, lastPayload, earlyCompleted }
  private cachedCliModelList: string[] | null = null;
  private lastCacheCheckTime = 0;


  static getInstance(): ModelDownloadManager {
    if (!ModelDownloadManager.instance) {
      ModelDownloadManager.instance = new ModelDownloadManager();
    }
    return ModelDownloadManager.instance;
  }

  private constructor() {
    super();
  }

  /**
   * 使用 llama-cli -cl 获取已下载模型列表
   */
  private async getDownloadedModelsFromCli(): Promise<string[]> {
    const now = Date.now();
    if (this.cachedCliModelList && (now - this.lastCacheCheckTime < 5000)) {
      return this.cachedCliModelList;
    }

    try {
      const llamaEngineService = LlamaEngineService.getInstance();
      await llamaEngineService.ensureEngineDeployed();
      
      const cliPath = llamaEngineService.getCliBinaryPath();
      if (!fs.existsSync(cliPath)) return [];

      const baseDir = unifiedModelManager.getModelBaseDir();

      const cmd = `"${cliPath}" -cl`;
      
      const finalEnv: Record<string, string> = {};
      const baseEnv = { ...process.env };
      
      // 处理 Path 变量冲突
      const pathKey = Object.keys(baseEnv).find(k => k.toLowerCase() === 'path') || 'Path';
      for (const [key, value] of Object.entries(baseEnv)) {
        if (key.toLowerCase() === 'path') continue; // 跳过，统一处理
        if (value !== undefined) finalEnv[key] = value as string;
      }
      const engineDir = path.dirname(cliPath);
      finalEnv[pathKey] = `${engineDir};${baseEnv[pathKey] || ''}`;
      
      const { stdout } = await execAsync(cmd, {
        env: { ...finalEnv, LLAMA_CACHE: baseDir }
      });

      const models: string[] = [];
      const cleanStdout = stdout.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-z]/g, '');
      const lines = cleanStdout.split(/\r?\n/);
      for (const line of lines) {
        const match = line.trim().match(/^\d+\.\s+(.+)$/);
        if (match) models.push(match[1].trim());
      }

      this.cachedCliModelList = models;
      this.lastCacheCheckTime = now;
      return models;
    } catch (error) {
      logger.error(LogCategory.AI, `执行 llama-cli -cl 失败:`, error);
      return [];
    }
  }

  /**
   * 检查模型是否已下载
   * 对于 Ollama，直接查询其目录；对于 llama.cpp，使用 --cache-list
   */
  async checkModelDownloadStatus(modelId: string): Promise<DownloadTaskSummary> {
    // 确保元数据已加载
    await unifiedModelManager.ensureLoaded();
    
    const model = unifiedModelManager.getModelById(modelId);
    
    if (model && model.source === 'ollama') {
      // 动态加载避免循环依赖
      const { OllamaService } = await import('./ollama-service');
      const isInstalled = await OllamaService.getInstance().checkModelInstalled(modelId);
      return { 
        modelId,
        isDownloaded: isInstalled, 
        downloadProgress: isInstalled ? 100 : 0,
        status: isInstalled ? DownloadStatus.COMPLETED : DownloadStatus.PENDING
      };
    } else {
      // 针对 llama.cpp / llamafile 引擎
      // 1. 优先通过文件系统解析路径来判断是否已下载
      const resolution = await unifiedModelManager.resolveModelPaths(modelId);
      
      if (resolution) {
        return { 
          modelId,
          isDownloaded: true, 
          downloadProgress: 100,
          status: DownloadStatus.COMPLETED,
          modelPath: resolution.modelPath
        };
      }

      // 2. 检查是否正在下载中
      const downloadingProcess = Array.from(this.activeProcesses.values()).find(p => p.lastPayload?.modelId === modelId);
      if (downloadingProcess) {
        // 如果已经标记为提前完成（例如发现文件已就绪），则视为已下载
        if (downloadingProcess.earlyCompleted) {
          return {
            modelId,
            isDownloaded: true,
            downloadProgress: 100,
            status: DownloadStatus.COMPLETED,
            modelPath: undefined
          };
        }

        return {
          modelId,
          isDownloaded: false,
          downloadProgress: downloadingProcess.lastPayload?.percent || 0,
          status: DownloadStatus.DOWNLOADING,
          modelPath: undefined
        };
      }

      // 3. 备选：通过 CLI 命令检查（虽然 resolveModelPath 已经覆盖了大部分情况，但这里保留作为兜底）
      const downloadedModels = await this.getDownloadedModelsFromCli();
      const isDownloadedInCli = downloadedModels.some(dm => {
        if (dm === modelId) return true;
        const cleanDm = dm.includes(':') ? dm.split(':')[0] + ':' + dm.split(':')[1].replace(/^UD-/, '') : dm;
        const cleanId = modelId.includes(':') ? modelId.split(':')[0] + ':' + modelId.split(':')[1].replace(/^UD-/, '') : modelId;
        return cleanDm === cleanId;
      });

      return { 
        modelId,
        isDownloaded: isDownloadedInCli, 
        downloadProgress: isDownloadedInCli ? 100 : 0,
        status: isDownloadedInCli ? DownloadStatus.COMPLETED : DownloadStatus.PENDING,
        modelPath: undefined
      };
    }
  }


  /**
   * 检查模型是否正在下载
   */
  isModelDownloading(modelId: string): boolean {
    // 检查是否有任何活跃进程的 taskId 包含该模型 ID
    for (const [taskId] of this.activeProcesses) {
      if (taskId.includes(modelId)) return true;
    }
    return false;
  }

  /**
   * 获取指定模型的当前任务
   * 如果正在下载，返回实时状态；如果已完成，返回已完成状态
   */
  public async getModelTask(modelId: string): Promise<DownloadTaskSummary | null> {
    // 1. 检查是否正在下载
    for (const [taskId, process] of this.activeProcesses.entries()) {
      if (process.lastPayload.modelId === modelId) {
        if (process.earlyCompleted) {
          return {
            ...process.lastPayload,
            status: DownloadStatus.COMPLETED,
            percent: 100
          };
        }
        return process.lastPayload;
      }
    }

    // 2. 检查磁盘上是否已存在模型
    const status = await this.checkModelDownloadStatus(modelId);
    if (status.isDownloaded) {
      return status;
    }

    return null;
  }

  /**
   * 获取任务实时状态
   */
  public getTaskStatus(taskId: string): DownloadTaskSummary | null {
    const task = this.activeProcesses.get(taskId);
    return task ? task.lastPayload : null;
  }

  async getAllTasks(): Promise<any[]> {
    const tasks: any[] = [];
    for (const [taskId, task] of this.activeProcesses) {
      tasks.push({ taskId, ...task.lastPayload });
    }
    return tasks;
  }

  async startDownload(modelId: string, webContentsId?: number): Promise<any> {
    await unifiedModelManager.ensureLoaded();

    const model = unifiedModelManager.getModelById(modelId);
    if (!model) throw new Error(`Model not found: ${modelId}`);

    const llamaEngineService = LlamaEngineService.getInstance();
    await llamaEngineService.ensureEngineDeployed();

    const taskId = `dl-${modelId}-${Date.now()}`;
    const strategy = await unifiedModelManager.getDownloadStrategy(modelId);
    const destDir = unifiedModelManager.getModelDirectory(modelId);

    const initialPayload = {
      taskId,
      modelId,
      status: DownloadStatus.DOWNLOADING,
      percent: 0,
      receivedBytes: 0,
      totalBytes: 0
    };

    // 1. 发送开始事件
    this.broadcastEvent('model-download-progress', initialPayload);

    // 2. 启动引擎原生拉取进程
    logger.info(LogCategory.MODEL_SERVICE, `执行原生下载指令: ${strategy.command}`);

    // 关键修正：修复 Windows 下 Path/PATH 变量名冲突，并智能处理代理
    const finalEnv: Record<string, string> = {};
    const baseEnv = { ...process.env, ...strategy.env };
    
    // 1. 寻找主 Path 变量名并统一
    const pathKey = Object.keys(baseEnv).find(k => k.toLowerCase() === 'path') || 'Path';
    
    // 2. 合并环境变量，同时避免重复的 Path 键名
    for (const [key, value] of Object.entries(baseEnv)) {
      if (key.toLowerCase() === 'path') continue;
      if (value !== undefined) finalEnv[key] = value as string;
    }
    finalEnv[pathKey] = baseEnv[pathKey] as string;
    
    // 极其关键：针对 Windows 管道缓冲问题的“诱导”变量
    // 很多基于 C++ (如 llama.cpp) 的工具会根据这些变量决定是否使用块缓冲
    finalEnv['PYTHONUNBUFFERED'] = '1';
    finalEnv['CLICOLOR_FORCE'] = '1';
    finalEnv['FORCE_COLOR'] = '1';
    finalEnv['TERM'] = 'cygwin'; // 伪装成 cygwin 终端，Windows 二进制文件经常对此敏感
    finalEnv['DEBIAN_FRONTEND'] = 'noninteractive';
    finalEnv['STDBUF_OUT'] = '0'; // 诱导支持 stdbuf 的库
    finalEnv['STDBUF_ERR'] = '0';
    
    // 智能代理处理：如果使用了国内镜像，确保不走国外代理
    if (finalEnv['HF_ENDPOINT'] && finalEnv['HF_ENDPOINT'].includes('hf-mirror.com')) {
      const currentNoProxy = Object.keys(finalEnv).find(k => k.toLowerCase() === 'no_proxy');
      const noProxyKey = currentNoProxy || 'NO_PROXY';
      const domains = ['hf-mirror.com', 'modelscope.cn', 'aliyun.com'];
      const existing = finalEnv[noProxyKey] || '';
      finalEnv[noProxyKey] = existing ? `${existing},${domains.join(',')}` : domains.join(',');
      logger.debug(LogCategory.MODEL_SERVICE, `检测到国内镜像，已自动配置 NO_PROXY: ${finalEnv[noProxyKey]}`);
    }
    
    logger.debug(LogCategory.MODEL_SERVICE, `下载进程环境变量已就绪，Path 变量名: ${pathKey}, 包含 HF_ENDPOINT: ${!!finalEnv['HF_ENDPOINT']}`);
    
    // 关键修正：在 shell 模式下，直接传递完整命令行字符串，避免手动拆分导致的引号丢失问题
    const child = spawn(strategy.command, {
      env: finalEnv,
      shell: true
    });

    // 关键修正：立即关闭 stdin，防止进程进入交互模式并挂起
    if (child.stdin) {
      child.stdin.end();
    }

    this.activeProcesses.set(taskId, { child, lastPayload: initialPayload });

    // 3. 监控进度 (使用缓冲区处理行分割，并增强对 \r 和单行流的支持)
    let stdoutBuffer = '';
    let stderrBuffer = '';

    const processLine = (line: string) => {
      if (!line.trim()) return;

      // 增强 ANSI 清理：处理更多转义序列，包括移动光标等
      const cleanLine = line
        .replace(/\x1B[@-_][0-?]*[ -/]*[@-~]/g, '') // 完整的 ANSI 转义序列正则
        .replace(/[│─╴┐└┘┌]/g, '') // 清理进度条装饰字符
        .trim();
      
      if (!cleanLine) return;

      const payload: any = {
        taskId,
        modelId,
        status: DownloadStatus.DOWNLOADING
      };

      // 1. 匹配进度百分比 (例如 "3%" 或 "[ 3%]")
      const progressMatches = [...cleanLine.matchAll(/(\d+(?:\.\d+)?)%/g)];
      if (progressMatches.length > 0) {
        const percents = progressMatches.map(m => parseFloat(m[1]));
        payload.percent = Math.max(...percents);
        logger.debug(LogCategory.MODEL_SERVICE, `[下载解析] 提取到进度: ${payload.percent}%`);
      }

      // 2. 匹配已下载和总大小 (例如 "1.2 GB / 4.5 GB")
      const bytesMatch = cleanLine.match(/([\d.]+)\s*(GB|MB|KB|B)\s*[\/\\]\s*([\d.]+)\s*(GB|MB|KB|B)/i);
      if (bytesMatch) {
        payload.receivedBytes = this.parseSizeToBytes(parseFloat(bytesMatch[1]), bytesMatch[2]);
        payload.totalBytes = this.parseSizeToBytes(parseFloat(bytesMatch[3]), bytesMatch[4]);
      }

      // 3. 匹配下载速度
      const speedMatch = cleanLine.match(/([\d.]+)\s*(GB|MB|KB|B)\/s/i);
      if (speedMatch) {
        payload.speedBps = this.parseSizeToBytes(parseFloat(speedMatch[1]), speedMatch[2]);
      }

      // 只有当有实际信息或包含关键关键字时才广播
      const hasActualProgress = payload.percent !== undefined || payload.receivedBytes !== undefined || payload.speedBps !== undefined;
      if (hasActualProgress || cleanLine.includes('Downloading')) {
        // 更新最后一次载荷缓存
        const task = this.activeProcesses.get(taskId);
        if (task) {
          task.lastPayload = { ...task.lastPayload, ...payload };
        }
        this.broadcastEvent('model-download-progress', payload);
      }
    };

    const handleData = (data: Buffer, bufferRef: { val: string }, isError: boolean) => {
      const str = data.toString();
      
      // 深度调试：记录收到的数据块大小和开头部分，确认是否存在缓冲
      logger.debug(LogCategory.MODEL_SERVICE, `[下载流] 收到数据 (${isError ? 'stderr' : 'stdout'}): ${data.length} 字节, 开头: ${str.substring(0, 50).replace(/\r/g, '\\r').replace(/\n/g, '\\n')}`);
      
      bufferRef.val += str;
      
      // 1. 尝试按行分割处理
      const lines = bufferRef.val.split(/\r?\n|\r/);
      bufferRef.val = lines.pop() || '';
      
      for (const line of lines) {
        processLine(line);
      }

      // 2. 【极其关键】处理“不换行”的实时进度
      if (str.includes('%') || str.toLowerCase().includes('downloading')) {
        processLine(bufferRef.val);
      }

      // 错误日志记录
      if (isError && bufferRef.val) {
        const err = bufferRef.val.trim();
        const isHarmless = err.includes('HEAD failed') || err.includes('no remote preset found') || err.includes('skipping');
        if (!isHarmless && (err.includes('Error') || err.includes('failed') || err.includes('error:'))) {
          logger.error(LogCategory.MODEL_SERVICE, `下载流异常: ${err}`);
        }
      }
    };

    const stdoutRef = { val: stdoutBuffer };
    const stderrRef = { val: stderrBuffer };

    child.stdout.on('data', (data) => handleData(data, stdoutRef, false));
    child.stderr.on('data', (data) => handleData(data, stderrRef, true));

    // 4. 终极兜底方案：磁盘文件尺寸轮询
    // 应对某些极端情况下 OS 管道缓冲区被锁死，导致我们在完成前收不到任何标准输出流的情况
    const repoName = modelId.split(':')[0]; // 例如 llmfan46/gemma...
    // 关键修正：不能只看 process.env，必须看最终传递给子进程的 finalEnv，它包含了用户自定义的模型目录！
    // 适配 llama.cpp：它使用 LLAMA_CACHE 来存放 HuggingFace 的镜像文件
    const llamaCacheKey = Object.keys(finalEnv).find(k => k.toUpperCase() === 'LLAMA_CACHE');
    const hfHomeKey = Object.keys(finalEnv).find(k => k.toUpperCase() === 'HF_HOME');
    
    const hfHome = (llamaCacheKey ? finalEnv[llamaCacheKey] : undefined) || 
                   (hfHomeKey ? finalEnv[hfHomeKey] : undefined) || 
                   process.env.HF_HOME || 
                   path.join(process.env.USERPROFILE || process.env.HOME || '', '.cache', 'huggingface', 'hub');
                   
    const repoDir = unifiedModelManager.getModelDirectory(modelId);
    const blobsDir = path.join(repoDir, 'blobs');
    const snapshotsDir = path.join(repoDir, 'snapshots');
    
    let modelTotalBytes = 0;
    const totalMatch = model.totalSize?.match(/([\d.]+)\s*(GB|MB|KB|B)/i);
    if (totalMatch) {
      modelTotalBytes = this.parseSizeToBytes(parseFloat(totalMatch[1]), totalMatch[2]);
    }
    let lastCheckTime = Date.now();
    let lastCheckBytes = 0;

    const fallbackTimer = setInterval(async () => {
      try {
        // 1. 检测 snapshots 目录（提前结束标志）
        // 必须根据特定的 modelTag 进行判断，因为不同 Tag 的模型共享同一个 repo 根目录
        const modelTag = modelId.includes(':') ? modelId.split(':').pop() : '';
        if (fs.existsSync(snapshotsDir) && modelTag) {
          const snapshotFolders = await fs.promises.readdir(snapshotsDir);
          let hasCurrentModelFile = false;
          
          for (const folder of snapshotFolders) {
            const folderPath = path.join(snapshotsDir, folder);
            const stat = await fs.promises.stat(folderPath).catch(() => null);
            if (stat?.isDirectory()) {
              const contents = await fs.promises.readdir(folderPath).catch(() => []);
              // 检查文件名是否包含当前的 Tag
              if (contents.some(name => name.includes(modelTag!))) {
                hasCurrentModelFile = true;
                break;
              }
            }
          }

          if (hasCurrentModelFile) {
            const task = this.activeProcesses.get(taskId);
            if (task) {
              logger.info(LogCategory.MODEL_SERVICE, `[提前结束检测] 发现 snapshots 目录已建立匹配 Tag (${modelTag}) 的文件，判定模型 ${modelId} 下载完成。`);
              // 标记为提前完成，close 事件不应再处理错误逻辑
              task.earlyCompleted = true;

              // 关键补丁：同步更新 lastPayload，防止 poll 导致状态回退
              task.lastPayload = {
                ...task.lastPayload,
                status: DownloadStatus.COMPLETED,
                percent: 100,
                receivedBytes: task.lastPayload?.totalBytes || task.lastPayload?.receivedBytes || 0,
                totalBytes: task.lastPayload?.totalBytes || 0
              };

              // 广播 COMPLETED 状态，通知前端切换为激活按钮
              this.broadcastEvent('model-download-complete', {
                taskId, modelId, status: DownloadStatus.COMPLETED, percent: 100,
                receivedBytes: task.lastPayload.receivedBytes,
                totalBytes: task.lastPayload.totalBytes
              });
              
              // 延迟 1 秒后强杀进程，防止进入 CPU 推理卡死电脑
              setTimeout(() => {
                const currentTask = this.activeProcesses.get(taskId);
                if (currentTask && currentTask.child) {
                  logger.warn(LogCategory.MODEL_SERVICE, `[清理下载进程] 强杀已下载完成的进程，防止 CPU 推理卡死`);
                  currentTask.child.kill('SIGKILL');
                }
                // 注意：这里不再调用 delete(taskId)，由 close 事件统一清理
              }, 1000);
              clearInterval(fallbackTimer);
              return;
            }
          }
        }

        // 2. 正常的 blobs 目录轮询逻辑
        if (!fs.existsSync(blobsDir)) return;
        const files = await fs.promises.readdir(blobsDir);
        if (files.length === 0) return;

        let currentBytes = 0;
        for (const f of files) {
          const filePath = path.join(blobsDir, f);
          try {
            const fd = await fs.promises.open(filePath, 'r');
            const stats = await fd.stat();
            if (stats.isFile()) currentBytes += stats.size;
            await fd.close();
          } catch (e) {
            const stats = await fs.promises.stat(filePath);
            if (stats.isFile()) currentBytes += stats.size;
          }
        }

        const task = this.activeProcesses.get(taskId);
        if (task && modelTotalBytes > 0) {
          if (currentBytes > (task.lastPayload?.receivedBytes || 0)) {
            // 动态调整总大小：如果实际超过了预估，动态扩大，确保 UI 看起来没溢出
            let dynamicTotalBytes = modelTotalBytes;
            if (currentBytes >= modelTotalBytes * 0.98) {
              dynamicTotalBytes = Math.max(modelTotalBytes, Math.floor(currentBytes * 1.05));
            }

            let percent = (currentBytes / dynamicTotalBytes) * 100;
            if (percent > 99) percent = 99; // 兜底：未收到退出信号前最高 99%
            
            const now = Date.now();
            const timeDiff = (now - lastCheckTime) / 1000;
            let speedBps = 0;
            if (timeDiff > 0 && lastCheckBytes > 0) {
              speedBps = Math.max(0, (currentBytes - lastCheckBytes) / timeDiff);
            }
            
            // 预计剩余时间
            const remainingTime = speedBps > 1024 ? (dynamicTotalBytes - currentBytes) / speedBps : -1;

            const payload = {
              taskId,
              modelId,
              status: DownloadStatus.DOWNLOADING,
              percent,
              receivedBytes: currentBytes,
              totalBytes: dynamicTotalBytes,
              speedBps,
              remainingTime,
              isDynamicTotal: currentBytes >= modelTotalBytes
            };
            
            task.lastPayload = { ...task.lastPayload, ...payload };
            lastCheckTime = now;
            lastCheckBytes = currentBytes;
            
            this.broadcastEvent('model-download-progress', payload);
            logger.debug(LogCategory.MODEL_SERVICE, `[磁盘轮询] ${percent.toFixed(1)}% | 速度: ${(speedBps/1024/1024).toFixed(2)} MB/s | 剩余: ${remainingTime > 0 ? remainingTime.toFixed(0) + 's' : '未知'}`);
          } else {
            lastCheckTime = Date.now();
            lastCheckBytes = currentBytes;
          }
        }
      } catch (e) {
        // 忽略异常
      }
    }, 1500);


    child.on('close', async (code) => {
      clearInterval(fallbackTimer);
      const task = this.activeProcesses.get(taskId);

      // 1. 如果任务不存在，说明可能已经被清理（例如手动取消或极端竞争）
      if (!task) {
        logger.debug(LogCategory.MODEL_SERVICE, `[close 事件] 任务 ${taskId} 不存在，忽略此事件 (退出码: ${code})`);
        return;
      }

      // 2. 如果已被提前结束检测标记为完成，则忽略此事件（进程是被我们主动 kill 的）
      if (task.earlyCompleted) {
        logger.info(LogCategory.MODEL_SERVICE, `[close 事件] 模型 ${modelId} 已由提前结束检测处理，忽略 close 事件 (退出码: ${code})`);
        this.activeProcesses.delete(taskId);
        return;
      }
      
      // 3. 针对 Windows 下的异常退出码进行宽泛判断
      // 4294967295 (即 -1) 往往是进程正常结束但清理阶段产生的信号冲突
      let isActuallySuccess = code === 0 || code === 4294967295 || code === -1;

      // 4. 二次检查：即使退出码不为 0，如果 snapshots 目录下已有匹配文件，也视为成功
      if (!isActuallySuccess) {
        const modelTag = modelId.includes(':') ? modelId.split(':').pop() : '';
        if (snapshotsDir && modelTag && fs.existsSync(snapshotsDir)) {
          try {
            const snapshotFolders = await fs.promises.readdir(snapshotsDir);
            for (const folder of snapshotFolders) {
              const folderPath = path.join(snapshotsDir, folder);
              const stat = await fs.promises.stat(folderPath).catch(() => null);
              if (stat?.isDirectory()) {
                const contents = await fs.promises.readdir(folderPath).catch(() => []);
                if (contents.some(name => name.includes(modelTag!))) {
                  logger.info(LogCategory.MODEL_SERVICE, `[close 事件修正] 进程虽然退出码为 ${code}，但二次检测到文件已就绪，判定成功。`);
                  isActuallySuccess = true;
                  break;
                }
              }
            }
          } catch (e) {
            // 忽略检查异常
          }
        }
      }

      if (isActuallySuccess) {
        this.activeProcesses.delete(taskId);
        logger.info(LogCategory.MODEL_SERVICE, `模型 ${modelId} 下载成功 (退出码: ${code})`);
        this.broadcastEvent('model-download-complete', { 
          taskId, 
          modelId, 
          status: DownloadStatus.COMPLETED, 
          percent: 100,
          receivedBytes: task.lastPayload?.receivedBytes || 0,
          totalBytes: task.lastPayload?.totalBytes || 0
        });
      } else {
        logger.error(LogCategory.MODEL_SERVICE, `下载进程异常退出，错误码: ${code}，请稍后再试或选择其它模型下载`);
        const errorPayload = {
          taskId,
          modelId,
          status: DownloadStatus.ERROR,
          error: t('下载进程异常退出 (错误码: {code})，请稍后再试或选择其它模型下载', { code }),
          percent: task.lastPayload?.percent || 0
        };
        
        task.lastPayload = errorPayload;
        this.broadcastEvent('model-download-error', errorPayload);
        
        // 5 秒后清理，留出时间让前端同步错误状态
        setTimeout(() => {
          this.activeProcesses.delete(taskId);
        }, 5000);
      }
    });

    return {
      taskId,
      modelId,
      destDir,
      totalBytes: 0 // 原生进程下总大小由引擎管理
    };
  }

  /**
   * 取消下载
   */
  async cancelDownload(taskId: string): Promise<void> {
    const task = this.activeProcesses.get(taskId);
    if (task && task.child) {
      const child = task.child;
      
      if (process.platform === 'win32' && child.pid) {
        // Windows 下 shell: true 产生的子进程需要用 taskkill 彻底终止进程树
        try {
          await execAsync(`taskkill /F /T /PID ${child.pid}`);
          logger.info(LogCategory.MODEL_SERVICE, `[Windows] 使用 taskkill 成功终止任务进程树: ${taskId} (PID: ${child.pid})`);
        } catch (e) {
          logger.warn(LogCategory.MODEL_SERVICE, `[Windows] taskkill 终止进程失败: ${e instanceof Error ? e.message : String(e)}`);
          child.kill(); // 降级方案
        }
      } else {
        child.kill('SIGTERM');
        // 给一点时间让进程退出，如果没退出则强杀
        setTimeout(() => {
          try { if (child.pid) process.kill(child.pid, 0); child.kill('SIGKILL'); } catch (e) {}
        }, 1000);
      }

      this.activeProcesses.delete(taskId);
      this.broadcastEvent('model-download-progress', {
        taskId,
        status: DownloadStatus.CANCELLED,
        percent: task.lastPayload?.percent || 0
      });
      logger.info(LogCategory.MODEL_SERVICE, `下载任务已取消并广播事件: ${taskId}`);
    }
  }




  /**
   * 清除已下载模型列表缓存
   */
  public clearCache(): void {
    this.cachedCliModelList = null;
    this.lastCacheCheckTime = 0;
    logger.info(LogCategory.AI, '模型下载管理器缓存已清除');
  }

  private broadcastEvent(channel: string, payload: any) {
    BrowserWindow.getAllWindows().forEach(win => {
      win.webContents.send(channel, payload);
    });
  }

  private async hasGgufFiles(dir: string): Promise<boolean> {
    try {
      if (!fs.existsSync(dir)) return false;
      const files = await fs.promises.readdir(dir);
      return files.some(f => f.endsWith('.gguf'));
    } catch {
      return false;
    }
  }

  /**
   * 将解析出的数值和单位转换为字节数
   */
  private parseSizeToBytes(value: number, unit: string): number {
    const units: Record<string, number> = {
      'B': 1,
      'KB': 1024,
      'MB': 1024 * 1024,
      'GB': 1024 * 1024 * 1024,
      'TB': 1024 * 1024 * 1024 * 1024
    };
    return Math.round(value * (units[unit.toUpperCase()] || 1));
  }
}

export const modelDownloadManager = ModelDownloadManager.getInstance();
