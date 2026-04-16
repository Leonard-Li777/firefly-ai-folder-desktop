import { describe, it, expect, beforeEach, vi } from "vitest";
import { FileScannerService } from "@yonuc/core-engine/services/file-scanner-service";
import * as fs from "node:fs";
import * as path from "node:path";

describe('FileScannerService 集成验证', () => {
  let scanner: FileScannerService;

  beforeEach(() => {
    vi.clearAllMocks();
    scanner = new FileScannerService();
  });

  it('应该能够扫描目录并返回文件列表', async () => {
    // 模拟磁盘操作
    const testPath = process.cwd();
    const result = await scanner.scanDirectory(testPath);
    
    expect(result).toBeDefined();
    expect(Array.isArray(result.files)).toBe(true);
    expect(typeof result.totalSize).toBe('number');
  });
});
