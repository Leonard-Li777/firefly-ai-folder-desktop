/**
 * 纯授权状态枚举 (Zero-Dependency LicenseStatus Enum)
 * 供主进程、纯计算模块及单元测试无依赖安全引入。
 */
export enum LicenseStatus {
  AUTHORIZED = 'AUTHORIZED',
  UNAUTHORIZED = 'UNAUTHORIZED',
  EXPIRED = 'EXPIRED',
  TIME_TAMPERED = 'TIME_TAMPERED',
  PENDING_ONLINE = 'PENDING_ONLINE'
}
