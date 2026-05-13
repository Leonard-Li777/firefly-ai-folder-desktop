import { LogCategory, logger } from '@yonuc/shared';
import fixPath from 'fix-path';

// 在 macOS 和 Linux 上修复 PATH 环境变量
if (process.platform !== 'win32') {
  try {
    const fixPathFunc = typeof fixPath === 'function' ? fixPath : (fixPath as any).default;
    if (typeof fixPathFunc === 'function') {
      fixPathFunc();
    }
  } catch (e) {
    console.error('Failed to fix PATH in SystemIdentityService:', e);
  }
}

import { ConfigOrchestrator } from '../../config/config-orchestrator';
import type { IIdentityProvider } from '@yonuc/types/identity-types';
import { createSupabaseClient } from './supabase-client-factory';
import crypto from 'node:crypto';
import { machineId } from 'node-machine-id';

const APP_SECRET_KEY = process.env.APP_SECRET_KEY || 'yonuc-ai-folder-secret-key-2026';

export class SystemIdentityService implements IIdentityProvider {
    private static instance: SystemIdentityService | null = null;
    private _machineId: string | null = null;

    static getInstance(): SystemIdentityService {
        if (!SystemIdentityService.instance) {
            SystemIdentityService.instance = new SystemIdentityService();
        }
        return SystemIdentityService.instance;
    }

    async initialize(): Promise<void> {
        const config = ConfigOrchestrator.getInstance();
        const configId = config.getValue<string>('MACHINE_ID');

        if (configId) {
            this._machineId = configId;
        } else {
            try {
                // node-machine-id 默认返回的就是 SHA-256 哈希后的字符串 (无中划线)
                this._machineId = await machineId();
            } catch (e) {
                logger.error(LogCategory.SYSTEM_HEALTH, 'Failed to get system machine id, generating random hex id', { error: e });
                // 直接生成 64 位纯 Hex 字符串 (32 字节 = 256 位 = 64 个 Hex 字符)
                this._machineId = crypto.randomBytes(32).toString('hex');
            }
            if (this._machineId) {
                config.updateValue('MACHINE_ID', this._machineId);
                logger.info(LogCategory.SYSTEM_HEALTH, 'Machine ID initialized', { machineId: this._machineId });
            }
        }
    }

    getMachineId(): string {
        if (!this._machineId) {
            const configId = ConfigOrchestrator.getInstance().getValue<string>('MACHINE_ID');
            if (configId) {
                this._machineId = configId;
                return configId;
            }
            logger.warn(LogCategory.SUPABASE, 'SystemIdentityService not initialized, MACHINE_ID missing in config');
            return 'unknown-machine-id';
        }
        return this._machineId;
    }

    getSignature(): string {
        const id = this.getMachineId();
        return crypto.createHmac('sha256', APP_SECRET_KEY).update(id).digest('hex');
    }

    getFeatures(): Record<string, any> {
        const config = ConfigOrchestrator.getInstance();
        return {
            cpu: config.getValue('HARDWARE_CPU_INFO'),
            memory: config.getValue('HARDWARE_MEMORY_INFO'),
            gpus: config.getValue('HARDWARE_GPU_INFO'),
            storage: config.getValue('HARDWARE_STORAGE_INFO'),
            os: {
                platform: process.platform,
                arch: process.arch,
            },
            appVersion: __APP_VERSION__,
            timestamp: new Date().toISOString()
        };
    }
}
