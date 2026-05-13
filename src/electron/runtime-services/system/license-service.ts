import { LogCategory, logger, verifyLicense, formatRequestCode } from '@yonuc/shared';
import { ConfigOrchestrator } from '../../config/config-orchestrator';
import { SystemIdentityService } from './system-identity-service';
import { app, net } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { nativeFetch } from '../utils/native-network';

export enum LicenseStatus {
    AUTHORIZED = 'AUTHORIZED',
    UNAUTHORIZED = 'UNAUTHORIZED',
    EXPIRED = 'EXPIRED',
    TIME_TAMPERED = 'TIME_TAMPERED',
    PENDING_ONLINE = 'PENDING_ONLINE'
}

export class LicenseService {
    private static instance: LicenseService;
    private licenseFilePath: string;
    private publicKey: string;
    private isOnlineAuthorized: boolean = false; // 内存中的在线授权状态

    private constructor() {
        this.licenseFilePath = path.join(app.getPath('userData'), 'license.dat');
        // 公钥通过环境变量注入，或者在打包时定义
        const envKey = process.env.LICENSE_PUBLIC_KEY || '';
        this.publicKey = envKey.replace(/\\n/g, '\n');
    }

    static getInstance(): LicenseService {
        if (!LicenseService.instance) {
            LicenseService.instance = new LicenseService();
        }
        return LicenseService.instance;
    }

    /**
     * 获取机器请求码
     */
    async getRequestCode(): Promise<string> {
        const machineId = SystemIdentityService.getInstance().getMachineId();
        return formatRequestCode(machineId);
    }

    /**
     * 检查授权状态 (核心逻辑)
     */
    async checkLicenseStatus(): Promise<{ status: LicenseStatus; expiry?: string; error?: string; type?: string }> {
        const machineId = SystemIdentityService.getInstance().getMachineId();
        const requestCode = formatRequestCode(machineId);

        logger.info(LogCategory.SYSTEM, '[License] 开始授权状态校验...', { 
            machineId, 
            requestCode,
            licensePath: this.licenseFilePath,
            isOnlineAuthorized: this.isOnlineAuthorized
        });

        // 1. 优先检查离线授权文件 (最可靠，离线可用，企业版用户首选)
        const offlineResult = await this.checkOfflineLicense();
        if (offlineResult.status === LicenseStatus.AUTHORIZED) {
            logger.info(LogCategory.SYSTEM, `[License] 离线授权校验成功`);
            return offlineResult;
        }

        // 记录离线授权是否过期，以便后续回退或兜底
        const isOfflineExpired = offlineResult.status === LicenseStatus.EXPIRED;
        if (isOfflineExpired) {
            logger.warn(LogCategory.SYSTEM, `[License] 离线授权已过期，尝试回退到在线授权验证`);
        }

        // 2. 检查内存中的在线授权状态 (个人版用户)
        if (this.isOnlineAuthorized) {
            logger.info(LogCategory.SYSTEM, '[License] 检测到内存中已标记在线授权，正在校验真实连通性...');
            // 核心修复：防止 net.isOnline 的假阳性 (例如有局域网但无互联网)
            const isActuallyOnline = await this.checkRealConnectivity();
            
            if (isActuallyOnline) {
                logger.info(LogCategory.SYSTEM, '[License] 在线连通性校验通过');
                return { status: LicenseStatus.AUTHORIZED, type: 'ONLINE' };
            } else {
                logger.warn(LogCategory.SYSTEM, '[License] 在线连通性校验未通过，可能处于断网环境');
                // 如果是在线授权有效但没网，这时候不应该直接报 UNAUTHORIZED，而应该报"网络连接失败"
                return { status: LicenseStatus.UNAUTHORIZED, error: '网络连接超时，请检查互联网连接' };
            }
        }

        // 3. 检查时间回拨
        try {
            this.checkTimeIntegrity();
        } catch (e) {
            logger.warn(LogCategory.SYSTEM, '[License] 时间完整性校验失败:', e instanceof Error ? e.message : String(e));
            return { status: LicenseStatus.TIME_TAMPERED, error: e instanceof Error ? e.message : '检测到系统时间异常' };
        }

        // 5. 最终兜底：如果之前离线授权过期了，即便没有在线授权，也应该返回 EXPIRED 而不是 UNAUTHORIZED
        if (isOfflineExpired) {
             return offlineResult;
        }

        logger.info(LogCategory.SYSTEM, '[License] 未找到有效授权');
        return { status: LicenseStatus.UNAUTHORIZED };
    }

    /**
     * 检查互联网真实连通性 (避免假阳性)
     */
    private async checkRealConnectivity(): Promise<boolean> {
        const isOnline = net.isOnline();
        logger.info(LogCategory.SYSTEM, `[License] 开始检查网络连通性, net.isOnline(): ${isOnline}`);
    
        const orchestrator = ConfigOrchestrator.getInstance();
        const mirror = orchestrator.getValue<'cn' | 'global'>('DOWNLOAD_MIRROR') || 'cn';
    
        const checkUrl = async (url: string, timeoutMs: number) => {
            const start = Date.now();
            try {
                logger.debug(LogCategory.SYSTEM, `[License] 正在尝试连接: ${url} (超时: ${timeoutMs}ms)`);
                // 使用 Electron 原生 net 模块，与 Chrome 使用相同的网络栈
                const res = await nativeFetch(url, { 
                    method: 'HEAD', 
                    timeout: timeoutMs 
                });
                logger.debug(LogCategory.SYSTEM, `[License] 连接成功: ${url}, 耗时: ${Date.now() - start}ms, 状态码: ${res.status}`);
                return true;
            } catch (e) {
                logger.warn(LogCategory.SYSTEM, `[License] 连接失败: ${url}, 耗时: ${Date.now() - start}ms, 错误: ${e instanceof Error ? e.message : String(e)}`);
                return false;
            }
        };
    
        // 1. 优先检查 Supabase 连通性 (这是本应用能正常工作的关键路径)
        const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
        if (supabaseUrl) {
            const isSupabaseOk = await checkUrl(supabaseUrl, 5000);
            if (isSupabaseOk) return true;
        }
    
        // 2. 备选逻辑：如果主服务器宕机，通过地域对应的 HA 地址确认"用户确已联网"
        // 国际化支持：国内检查百度，国外检查 Google
        const fallbackUrl = mirror === 'global' ? 'https://www.google.com' : 'https://www.baidu.com';
        logger.info(LogCategory.SYSTEM, `[License] 主服务器连接失败，尝试备选地址: ${fallbackUrl}`);
            
        const isFallbackOk = await checkUrl(fallbackUrl, 5000);
        
        // 最终判定：如果 net.isOnline 为 false 但请求成功了，也认为是在线的
        if (isFallbackOk) return true;

        // 如果所有请求都失败了，再看 net.isOnline 是否为 true。
        // 但通常如果请求全挂了，即便 net.isOnline 为 true 也没用。
        return false;
    }

    /**
     * 检查本地离线授权文件 (兼容读取配置文件和物理文件)
     */
    private async checkOfflineLicense(): Promise<{ status: LicenseStatus; expiry?: string; error?: string; type?: string }> {
        const config = ConfigOrchestrator.getInstance();
        let licenseStr = config.getValue<string>('OFFLINE_LICENSE');

        if (!licenseStr && fs.existsSync(this.licenseFilePath)) {
            logger.info(LogCategory.SYSTEM, '[License] 配置中未找到授权，尝试读取本地授权文件:', this.licenseFilePath);
            licenseStr = fs.readFileSync(this.licenseFilePath, 'utf8');
            // 同步到配置中
            if (licenseStr) {
                 await config.updateValue('OFFLINE_LICENSE', licenseStr, { source: 'runtime' });
            }
        }

        if (!licenseStr) {
            return { status: LicenseStatus.UNAUTHORIZED };
        }

        if (!this.publicKey) {
            return { status: LicenseStatus.UNAUTHORIZED, error: '系统配置错误' };
        }

        const machineId = SystemIdentityService.getInstance().getMachineId();
        const requestCode = formatRequestCode(machineId);

        try {
            const result = await verifyLicense(licenseStr, this.publicKey);
            if (!result.valid || !result.data) {
                return { status: LicenseStatus.UNAUTHORIZED, error: result.error };
            }

            const { ids, expiry, type } = result.data;

            // 校验机器码
            if (!ids.includes(machineId) && !ids.includes(requestCode)) {
                return { status: LicenseStatus.UNAUTHORIZED, error: '授权码与当前机器不匹配' };
            }

            // 校验有效期
            const expiryDate = new Date(expiry);
            if (expiryDate.getTime() < Date.now()) {
                return { status: LicenseStatus.EXPIRED, expiry };
            }

            return { status: LicenseStatus.AUTHORIZED, expiry, type };
        } catch (e) {
            return { status: LicenseStatus.UNAUTHORIZED, error: '校验失败' };
        }
    }

    /**
     * 激活离线授权码
     */
    async activate(licenseCode: string): Promise<{ success: boolean; error?: string }> {
        const config = ConfigOrchestrator.getInstance();
        const machineId = SystemIdentityService.getInstance().getMachineId();
        const requestCode = formatRequestCode(machineId);

        if (!this.publicKey) {
             return { success: false, error: '系统未配置公钥' };
        }

        const result = await verifyLicense(licenseCode, this.publicKey);
        if (!result.valid || !result.data) {
            return { success: false, error: result.error || '授权码无效' };
        }

        if (!result.data.ids.includes(machineId) && !result.data.ids.includes(requestCode)) {
            return { success: false, error: '该授权码不适用于当前机器' };
        }

        // 校验有效期
        const expiryDate = new Date(result.data.expiry);
        if (expiryDate.getTime() < Date.now()) {
            return { success: false, error: '该授权码已过期' };
        }

        // 持久化到文件和配置
        try {
            fs.writeFileSync(this.licenseFilePath, licenseCode, 'utf8');
            await config.updateValue('OFFLINE_LICENSE', licenseCode, { source: 'runtime' });
            return { success: true };
        } catch (e) {
            return { success: false, error: '写入授权失败' };
        }
    }

    /**
     * 时间完整性检查
     */
    checkTimeIntegrity(): void {
        const config = ConfigOrchestrator.getInstance();
        const currentTime = Date.now();
        const lastRun = config.getValue<number>('LAST_RUN_TIME') || 0;

        if (lastRun > 0 && currentTime < lastRun - 5 * 60 * 1000) { // 允许 5 分钟误差
            throw new Error("检测到系统时间异常，请校准时间后再运行。");
        }

        // 更新最后运行时间
        config.updateValue('LAST_RUN_TIME', currentTime);
    }

    /**
     * 设置在线授权状态
     */
    setOnlineAuthorized(authorized: boolean): void {
        this.isOnlineAuthorized = authorized;
        logger.info(LogCategory.SYSTEM, `[License] 设置在线授权状态为: ${authorized}`);
    }

    /**
     * 启动定时更新运行时间
     */
    startTimeMonitor(): void {
        setInterval(() => {
            try {
                const config = ConfigOrchestrator.getInstance();
                config.updateValue('LAST_RUN_TIME', Date.now());
            } catch (e) {
                logger.error(LogCategory.SYSTEM, '更新最后运行时间失败', e);
            }
        }, 10 * 60 * 1000); // 每10分钟
    }
}
