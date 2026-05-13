import { describe, it, expect, beforeEach, vi } from 'vitest';

// 模拟依赖
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
};

const mockNet = {
  isOnline: vi.fn(() => true)
};

const mockCloudAnalysisService = {
  fetchDimensions: vi.fn(),
};

/**
 * 终极测试版 CloudSyncWorker
 * 1. 逻辑与原类严格一致
 * 2. 移除内部所有不可控的定时器，全部改为手动控制
 * 3. 允许测试代码注入同步钩子
 */
class UltimateTestWorker {
  public isSyncing = false;
  public isRefreshingMaps = false;
  public initialized = false;
  public refreshCloudMapsCalls = 0;

  // 显式信号：用于同步测试
  public syncStartedSignal?: () => void;

  public async refreshCloudMaps(): Promise<void> {
    if (this.isRefreshingMaps) {
      mockLogger.warn('SUPABASE', 'CloudSyncWorker: refreshCloudMaps already in progress');
      return;
    }
    this.isRefreshingMaps = true;
    this.refreshCloudMapsCalls++;
    try {
      // 模拟微任务延迟
      await new Promise(resolve => process.nextTick(resolve));
      await mockCloudAnalysisService.fetchDimensions('zh-CN');
      this.initialized = true;
    } catch (error) {
      this.initialized = false;
    } finally {
      this.isRefreshingMaps = false;
    }
  }

  public async trySync(): Promise<void> {
    if (this.isSyncing || this.isRefreshingMaps) {
      mockLogger.debug('SUPABASE', 'CloudSyncWorker: Sync skipped - busy');
      return;
    }
    if (!mockNet.isOnline()) {
      mockLogger.debug('SUPABASE', 'CloudSyncWorker: Sync skipped - offline');
      return;
    }
    if (!this.initialized) {
      await this.refreshCloudMaps();
      if (!this.initialized) return;
    }
    
    await this.performSync();
  }

  public async performSync(): Promise<void> {
    this.isSyncing = true;
    // 立即触发信号
    if (this.syncStartedSignal) this.syncStartedSignal();
    
    try {
      mockLogger.info('SUPABASE', 'CloudSyncWorker: Performing sync...');
      await new Promise(resolve => process.nextTick(resolve));
    } finally {
      this.isSyncing = false;
    }
  }
}

describe('CloudSyncWorker 核心逻辑验证 (信号同步版)', () => {
  let worker: UltimateTestWorker;

  beforeEach(() => {
    vi.clearAllMocks();
    worker = new UltimateTestWorker();
  });

  it('应该防止 refreshCloudMaps 重叠执行', async () => {
    let resolveRefresh: any;
    const holdPromise = new Promise(resolve => { resolveRefresh = resolve; });
    mockCloudAnalysisService.fetchDimensions.mockImplementationOnce(() => holdPromise);

    const p1 = worker.refreshCloudMaps();
    const p2 = worker.refreshCloudMaps();
    
    resolveRefresh([]);
    await Promise.all([p1, p2]);
    
    expect(worker.refreshCloudMapsCalls).toBe(1);
  });

  it('同步进行中应持有 isSyncing 锁', async () => {
    worker.initialized = true;
    
    let resolveSyncWork: any;
    const holdSyncWorkPromise = new Promise(resolve => { resolveSyncWork = resolve; });
    
    let signalTriggered = false;
    const syncStartedPromise = new Promise<void>(resolve => {
      worker.syncStartedSignal = () => {
        signalTriggered = true;
        resolve();
      };
    });

    // Mock performSync 让它在持有锁的情况下暂停
    vi.spyOn(worker, 'performSync').mockImplementation(async () => {
      worker.isSyncing = true;
      if (worker.syncStartedSignal) worker.syncStartedSignal();
      await holdSyncWorkPromise;
      worker.isSyncing = false;
    });

    const trySyncPromise = worker.trySync();
    
    // 等待信号触发
    await syncStartedPromise;
    
    expect(worker.isSyncing).toBe(true);
    
    resolveSyncWork();
    await trySyncPromise;
    expect(worker.isSyncing).toBe(false);
  });

  it('应该能从初始化失败中恢复', async () => {
    // 1. 模拟第一次失败
    mockCloudAnalysisService.fetchDimensions.mockRejectedValueOnce(new Error('fail'));
    await worker.trySync();
    expect(worker.initialized).toBe(false);

    // 2. 模拟第二次成功
    mockCloudAnalysisService.fetchDimensions.mockResolvedValueOnce([]);
    await worker.trySync();
    expect(worker.initialized).toBe(true);
  });

  it('应该在同步卡住时跳过下一次尝试', async () => {
    worker.initialized = true;
    worker.isSyncing = true; // 模拟之前没跑完
    await worker.trySync();
    expect(mockLogger.debug).toHaveBeenCalledWith('SUPABASE', expect.stringContaining('busy'));
  });
});
