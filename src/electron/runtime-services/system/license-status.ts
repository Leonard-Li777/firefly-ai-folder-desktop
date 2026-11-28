/**
 * 纯授权状态枚举 (Zero-Dependency LicenseStatus Enum)
 * 供主进程、纯计算模块及单元测试无依赖安全引入。
 */
export enum LicenseStatus {
  AUTHORIZED = 'AUTHORIZED',
  UNAUTHORIZED = 'UNAUTHORIZED',
  EXPIRED = 'EXPIRED',
  TIME_TAMPERED = 'TIME_TAMPERED',
  PENDING_ONLINE = 'PENDING_ONLINE',
  /** 非终态过渡态：本地 3 天宽限期内先行放行主界面浏览，但 AI 能力与密钥派生保持锁定，等待后台云端校验确认 */
  LOCAL_GRACE_PENDING = 'LOCAL_GRACE_PENDING'
}
