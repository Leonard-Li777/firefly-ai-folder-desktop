import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import chokidar from 'chokidar';
import { fileWatcherService } from '../file-watcher-service';
import { databaseService } from '../../database/database-service';
import { analysisQueueService } from '../../analysis-queue-service';
import { configService } from '../../config/config-service';

// Mock dependencies
vi.mock('chokidar', () => ({
  default: {
    watch: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      close: vi.fn().mockResolvedValue(undefined),
      ready: vi.fn().mockReturnThis(),
    })),
  },
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
    statSync: vi.fn(() => ({
      isFile: () => true,
      size: 1024,
      mtime: new Date(),
    })),
    promises: {
      readdir: vi.fn().mockResolvedValue([]),
      stat: vi.fn().mockResolvedValue({
        mtime: new Date(),
        size: 1024,
      }),
    },
  },
}));

vi.mock('../../database/database-service', () => ({
  databaseService: {
    getAllWorkspaceDirectories: vi.fn().mockResolvedValue([]),
    findRootWorkspaceDirectory: vi.fn(),
    getFilesByParentPath: vi.fn().mockResolvedValue([]),
    addFileFromPath: vi.fn().mockResolvedValue(1),
    updateFileModifiedTime: vi.fn().mockResolvedValue(undefined),
    getFileByPath: vi.fn(),
    calculateFileFingerprint: vi.fn().mockResolvedValue('hash'),
  },
}));

vi.mock('../../analysis-queue-service', () => ({
  analysisQueueService: {
    addItems: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../config/config-service', () => ({
  configService: {
    getValue: vi.fn((key) => {
      if (key === 'AUTO_ANALYZE_NEW_FILES') return true;
      return undefined;
    }),
  },
}));

// Mock electron
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
}));

describe('FileWatcherService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('syncDirectory with autoWatch logic', () => {
    it('should NOT add new file to analysis queue if autoWatch is FALSE', async () => {
      const dirPath = 'D:/test-folder';
      const filePath = 'D:/test-folder/new-file.txt';
      const normalizedPath = filePath.replace(/\\/g, '/');

      // Setup workspace with autoWatch = false
      (databaseService.findRootWorkspaceDirectory as any).mockResolvedValue({
        id: 1,
        path: dirPath,
        autoWatch: false,
      });
      (databaseService.getAllWorkspaceDirectories as any).mockResolvedValue([{ id: 1, path: dirPath }]);
      
      // Mock disk files: one new file
      (fs.promises.readdir as any).mockResolvedValue([{ name: 'new-file.txt', isFile: () => true }]);
      (fs.promises.stat as any).mockResolvedValue({ mtime: new Date(), size: 1024 });

      // Mock DB files: empty
      (databaseService.getFilesByParentPath as any).mockResolvedValue([]);

      // Execute sync
      await fileWatcherService.syncDirectory(dirPath);

      // Verify: file added to DB but NOT to analysis queue
      expect(databaseService.addFileFromPath).toHaveBeenCalledWith(expect.any(String), dirPath, 1, true);
      expect(analysisQueueService.addItems).not.toHaveBeenCalled();
    });

    it('should add new file to analysis queue if autoWatch is TRUE', async () => {
      const dirPath = 'D:/test-folder';
      const filePath = 'D:/test-folder/new-file.txt';

      // Setup workspace with autoWatch = true
      (databaseService.findRootWorkspaceDirectory as any).mockResolvedValue({
        id: 1,
        path: dirPath,
        autoWatch: true,
      });
      (databaseService.getAllWorkspaceDirectories as any).mockResolvedValue([{ id: 1, path: dirPath }]);
      
      // Mock disk files: one new file
      (fs.promises.readdir as any).mockResolvedValue([{ name: 'new-file.txt', isFile: () => true }]);
      (fs.promises.stat as any).mockResolvedValue({ mtime: new Date(), size: 1024 });

      // Mock DB files: empty
      (databaseService.getFilesByParentPath as any).mockResolvedValue([]);

      // Execute sync
      await fileWatcherService.syncDirectory(dirPath);

      // Verify: file added to both DB and analysis queue
      expect(databaseService.addFileFromPath).toHaveBeenCalled();
      expect(analysisQueueService.addItems).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ name: 'new-file.txt' })
        ]),
        false
      );
    });

    it('should NOT re-add modified file to analysis queue if autoWatch is FALSE', async () => {
      const dirPath = 'D:/test-folder';
      const filePath = 'D:/test-folder/mod-file.txt';
      const normalizedPath = filePath.replace(/\\/g, '/');
      const now = new Date();
      const oldTime = new Date(now.getTime() - 10000);

      // Setup workspace with autoWatch = false
      (databaseService.findRootWorkspaceDirectory as any).mockResolvedValue({
        id: 1,
        path: dirPath,
        autoWatch: false,
      });
      (databaseService.getAllWorkspaceDirectories as any).mockResolvedValue([{ id: 1, path: dirPath }]);
      
      // Mock disk files: one modified file
      (fs.promises.readdir as any).mockResolvedValue([{ name: 'mod-file.txt', isFile: () => true }]);
      (fs.promises.stat as any).mockResolvedValue({ mtime: now, size: 1024 });

      // Mock DB files: existing file with old timestamp
      (databaseService.getFilesByParentPath as any).mockResolvedValue([
        { path: normalizedPath, modifiedAt: oldTime, size: 1024 }
      ]);

      // Execute sync
      await fileWatcherService.syncDirectory(dirPath);

      // Verify: DB updated but NOT analysis queue
      expect(databaseService.updateFileModifiedTime).toHaveBeenCalled();
      expect(analysisQueueService.addItems).not.toHaveBeenCalled();
    });
  });

  describe('Direct event handlers', () => {
    it('handleFileAdded should respect autoWatchEnabled parameter', async () => {
      const workspaceId = 1;
      const dirPath = 'D:/test-folder';
      const filePath = 'D:/test-folder/new.txt';

      // 1. When autoWatchEnabled is false
      await (fileWatcherService as any).handleFileAdded(workspaceId, dirPath, filePath, false);
      expect(analysisQueueService.addItems).not.toHaveBeenCalled();

      // 2. When autoWatchEnabled is true
      vi.clearAllMocks();
      await (fileWatcherService as any).handleFileAdded(workspaceId, dirPath, filePath, true);
      expect(analysisQueueService.addItems).toHaveBeenCalled();
    });

    it('handleFileChanged should respect autoWatchEnabled parameter', async () => {
      const workspaceId = 1;
      const dirPath = 'D:/test-folder';
      const filePath = 'D:/test-folder/mod.txt';

      (databaseService.getFileByPath as any).mockResolvedValue({
        path: filePath,
        contentHash: 'old-hash',
        isAnalyzed: true
      });
      (databaseService.calculateFileFingerprint as any).mockResolvedValue('new-hash');

      // 1. When autoWatchEnabled is false
      await (fileWatcherService as any).handleFileChanged(workspaceId, dirPath, filePath, false);
      expect(analysisQueueService.addItems).not.toHaveBeenCalled();

      // 2. When autoWatchEnabled is true
      vi.clearAllMocks();
      await (fileWatcherService as any).handleFileChanged(workspaceId, dirPath, filePath, true);
      expect(analysisQueueService.addItems).toHaveBeenCalled();
    });
  });
});
