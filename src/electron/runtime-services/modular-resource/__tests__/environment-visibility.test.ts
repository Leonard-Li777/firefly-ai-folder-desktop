import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  toLicenseSnapshot,
  computeEnvironmentVisibility,
  resolveEnvironmentVisibility,
  EnvironmentVisibilityEnvelopeManager,
  LicenseStatus,
  type LicenseSnapshot,
  type BuildChannel
} from '../environment-visibility'

describe('EnvironmentVisibility & BuildGate', () => {
  const now = 1700000000000
  const futureExpiry = new Date(now + 30 * 24 * 3600 * 1000).toISOString()
  const pastExpiry = new Date(now - 1000).toISOString()
  const exactNowExpiry = new Date(now).toISOString()

  const validOfflineSnapshot: LicenseSnapshot = {
    status: 'AUTHORIZED',
    normalizedType: 'ENTERPRISE_OFFLINE',
    tier: 'ENTERPRISE',
    canOffline: true,
    expiresAt: now + 1000000,
    perpetual: false
  }

  const freeSnapshot: LicenseSnapshot = {
    status: 'UNAUTHORIZED',
    normalizedType: 'UNKNOWN',
    tier: 'FREE',
    canOffline: false,
    expiresAt: null,
    perpetual: false
  }

  describe('toLicenseSnapshot', () => {
    it('should throw TypeError if nowMs is not a finite number', () => {
      expect(() =>
        toLicenseSnapshot(
          { status: LicenseStatus.AUTHORIZED, type: 'ENTERPRISE_OFFLINE', expiry: futureExpiry },
          NaN
        )
      ).toThrowError(/nowMs must be a finite number/)

      expect(() =>
        toLicenseSnapshot(
          { status: LicenseStatus.AUTHORIZED, type: 'ENTERPRISE_OFFLINE', expiry: futureExpiry },
          Infinity
        )
      ).toThrowError(/nowMs must be a finite number/)
    })

    it('should grant canOffline: true for valid ENTERPRISE_OFFLINE license', () => {
      const snapshot = toLicenseSnapshot(
        {
          status: LicenseStatus.AUTHORIZED,
          type: 'ENTERPRISE_OFFLINE',
          expiry: futureExpiry
        },
        now
      )

      expect(snapshot.status).toBe('AUTHORIZED')
      expect(snapshot.normalizedType).toBe('ENTERPRISE_OFFLINE')
      expect(snapshot.tier).toBe('ENTERPRISE')
      expect(snapshot.canOffline).toBe(true)
      expect(snapshot.expiresAt).toBe(Date.parse(futureExpiry))
      expect(snapshot.perpetual).toBe(false)
    })

    it('should fail-closed for ENTERPRISE_OFFLINE when expiry is missing', () => {
      const snapshot = toLicenseSnapshot(
        {
          status: LicenseStatus.AUTHORIZED,
          type: 'ENTERPRISE_OFFLINE'
        },
        now
      )

      expect(snapshot.status).toBe('UNAUTHORIZED')
      expect(snapshot.normalizedType).toBe('UNKNOWN')
      expect(snapshot.tier).toBe('ENTERPRISE')
      expect(snapshot.canOffline).toBe(false)
      expect(snapshot.expiresAt).toBeNull()
      expect(snapshot.perpetual).toBe(false)
    })

    it('should fail-closed for ENTERPRISE_OFFLINE when expiry is corrupted (NaN)', () => {
      const snapshot = toLicenseSnapshot(
        {
          status: LicenseStatus.AUTHORIZED,
          type: 'ENTERPRISE_OFFLINE',
          expiry: 'not-a-valid-date-string'
        },
        now
      )

      expect(snapshot.status).toBe('TIME_TAMPERED')
      expect(snapshot.normalizedType).toBe('UNKNOWN')
      expect(snapshot.canOffline).toBe(false)
      expect(snapshot.expiresAt).toBeNull()
      expect(snapshot.perpetual).toBe(false)
    })

    it('should mark EXPIRED for ENTERPRISE_OFFLINE when expiry is in the past', () => {
      const snapshot = toLicenseSnapshot(
        {
          status: LicenseStatus.AUTHORIZED,
          type: 'ENTERPRISE_OFFLINE',
          expiry: pastExpiry
        },
        now
      )

      expect(snapshot.status).toBe('EXPIRED')
      expect(snapshot.canOffline).toBe(false)
    })

    it('should mark EXPIRED when expiry is exactly nowMs (boundary condition)', () => {
      const snapshot = toLicenseSnapshot(
        {
          status: LicenseStatus.AUTHORIZED,
          type: 'ENTERPRISE_OFFLINE',
          expiry: exactNowExpiry
        },
        now
      )

      expect(snapshot.status).toBe('EXPIRED')
      expect(snapshot.canOffline).toBe(false)
    })

    it('should never grant canOffline: true for online ENTERPRISE license even if valid', () => {
      const snapshot = toLicenseSnapshot(
        {
          status: LicenseStatus.AUTHORIZED,
          type: 'ENTERPRISE',
          expiry: futureExpiry
        },
        now
      )

      expect(snapshot.status).toBe('AUTHORIZED')
      expect(snapshot.normalizedType).toBe('ONLINE')
      expect(snapshot.tier).toBe('ENTERPRISE')
      expect(snapshot.canOffline).toBe(false)
      expect(snapshot.perpetual).toBe(false)
    })

    it('should allow perpetual: true for non-offline license without expiry', () => {
      const snapshot = toLicenseSnapshot(
        {
          status: LicenseStatus.AUTHORIZED,
          type: 'ENTERPRISE'
        },
        now
      )

      expect(snapshot.status).toBe('AUTHORIZED')
      expect(snapshot.normalizedType).toBe('ONLINE')
      expect(snapshot.tier).toBe('ENTERPRISE')
      expect(snapshot.canOffline).toBe(false)
      expect(snapshot.perpetual).toBe(true)
    })

    it('should handle raw.type ONLINE and unknown types', () => {
      const onlineSnap = toLicenseSnapshot(
        { status: LicenseStatus.AUTHORIZED, type: 'ONLINE' },
        now
      )
      expect(onlineSnap.normalizedType).toBe('ONLINE')
      expect(onlineSnap.tier).toBe('FREE')
      expect(onlineSnap.perpetual).toBe(true)

      const unknownSnap = toLicenseSnapshot(
        { status: LicenseStatus.AUTHORIZED, type: 'COMMUNITY' },
        now
      )
      expect(unknownSnap.normalizedType).toBe('UNKNOWN')
      expect(unknownSnap.tier).toBe('FREE')
      expect(unknownSnap.perpetual).toBe(true)
    })

    it('should fail-closed when raw status is TIME_TAMPERED', () => {
      const snapshot = toLicenseSnapshot(
        {
          status: LicenseStatus.TIME_TAMPERED,
          type: 'ENTERPRISE_OFFLINE',
          expiry: futureExpiry
        },
        now
      )

      expect(snapshot.status).toBe('TIME_TAMPERED')
      expect(snapshot.normalizedType).toBe('UNKNOWN')
      expect(snapshot.canOffline).toBe(false)
      expect(snapshot.expiresAt).toBeNull()
    })

    it('should normalize expired license to status EXPIRED', () => {
      const snapshot = toLicenseSnapshot(
        {
          status: LicenseStatus.EXPIRED,
          type: 'ENTERPRISE_OFFLINE',
          expiry: pastExpiry
        },
        now
      )

      expect(snapshot.status).toBe('EXPIRED')
      expect(snapshot.normalizedType).toBe('UNKNOWN')
      expect(snapshot.tier).toBe('ENTERPRISE')
      expect(snapshot.canOffline).toBe(false)
    })

    it('should normalize unauthorized and pending_online license to UNAUTHORIZED', () => {
      const unauthSnap = toLicenseSnapshot(
        { status: LicenseStatus.UNAUTHORIZED, type: 'ENTERPRISE' },
        now
      )
      expect(unauthSnap.status).toBe('UNAUTHORIZED')
      expect(unauthSnap.tier).toBe('ENTERPRISE')

      const pendingSnap = toLicenseSnapshot(
        { status: LicenseStatus.PENDING_ONLINE, type: 'COMMUNITY' },
        now
      )
      expect(pendingSnap.status).toBe('UNAUTHORIZED')
      expect(pendingSnap.tier).toBe('FREE')
    })
  })

  describe('computeEnvironmentVisibility (Pure Kernel Matrix)', () => {
    it('should throw TypeError if nowMs is not a finite number in computeEnvironmentVisibility', () => {
      expect(() =>
        computeEnvironmentVisibility('dev', false, freeSnapshot, true, NaN)
      ).toThrowError(/nowMs must be a finite number/)
    })

    it('should enable full capabilities in dev mode when unpackaged', () => {
      const visibility = computeEnvironmentVisibility(
        'dev',
        false, // !isPackaged
        freeSnapshot,
        true, // developerModeEnabled
        now
      )

      expect(visibility.isDev).toBe(true)
      expect(visibility.isEnterpriseOffline).toBe(false)
      expect(visibility.developerModeEnabled).toBe(true)
      expect(visibility.allowDeveloperMode).toBe(true)
      expect(visibility.allowLocalPluginImport).toBe(true)
      expect(visibility.allowOfflineImport).toBe(true)
      expect(visibility.allowOfflineExport).toBe(true)
    })

    it('should lock local import when developerModeEnabled is false in dev mode', () => {
      const visibility = computeEnvironmentVisibility(
        'dev',
        false,
        freeSnapshot,
        false, // developerModeEnabled: false
        now
      )

      expect(visibility.isDev).toBe(true)
      expect(visibility.developerModeEnabled).toBe(false)
      expect(visibility.allowDeveloperMode).toBe(true)
      expect(visibility.allowLocalPluginImport).toBe(false)
      expect(visibility.allowOfflineImport).toBe(true)
      expect(visibility.allowOfflineExport).toBe(true)
    })

    it('should forbid dev privileges if channel is dev but packaged (tamper defense)', () => {
      const visibility = computeEnvironmentVisibility(
        'dev',
        true, // isPackaged = true
        freeSnapshot,
        true,
        now
      )

      expect(visibility.isDev).toBe(false)
      expect(visibility.allowDeveloperMode).toBe(false)
      expect(visibility.allowLocalPluginImport).toBe(false)
      expect(visibility.allowOfflineExport).toBe(false)
      expect(visibility.allowOfflineImport).toBe(true)
    })

    it('should forbid dev privileges if channel is production even if unpackaged (unpacked defense)', () => {
      const visibility = computeEnvironmentVisibility(
        'production',
        false, // unpackaged
        freeSnapshot,
        true,
        now
      )

      expect(visibility.isDev).toBe(false)
      expect(visibility.allowDeveloperMode).toBe(false)
      expect(visibility.allowLocalPluginImport).toBe(false)
      expect(visibility.allowOfflineExport).toBe(false)
    })

    it('should forbid dev privileges if channel is staging', () => {
      const vUnpackaged = computeEnvironmentVisibility('staging', false, freeSnapshot, true, now)
      expect(vUnpackaged.isDev).toBe(false)

      const vPackaged = computeEnvironmentVisibility('staging', true, freeSnapshot, true, now)
      expect(vPackaged.isDev).toBe(false)
    })

    it('should grant ONLY allowOfflineImport in production for ENTERPRISE_OFFLINE', () => {
      const visibility = computeEnvironmentVisibility(
        'production',
        true,
        validOfflineSnapshot,
        false,
        now
      )

      expect(visibility.isDev).toBe(false)
      expect(visibility.isEnterpriseOffline).toBe(true)
      expect(visibility.allowDeveloperMode).toBe(false)
      expect(visibility.allowLocalPluginImport).toBe(false)
      expect(visibility.allowOfflineImport).toBe(true)
      expect(visibility.allowOfflineExport).toBe(false)
    })

    it('should keep allowOfflineImport true in production even if enterprise offline license expired or absent while strictly keeping isEnterpriseOffline false', () => {
      const expiredOfflineSnapshot: LicenseSnapshot = {
        ...validOfflineSnapshot,
        expiresAt: now - 1000 // expired
      }
      const vExpired = computeEnvironmentVisibility(
        'production',
        true,
        expiredOfflineSnapshot,
        false,
        now
      )
      expect(vExpired.isEnterpriseOffline).toBe(false)
      expect(vExpired.allowOfflineImport).toBe(true)

      const nullExpirySnapshot: LicenseSnapshot = {
        ...validOfflineSnapshot,
        expiresAt: null
      }
      const vNull = computeEnvironmentVisibility('production', true, nullExpirySnapshot, false, now)
      expect(vNull.isEnterpriseOffline).toBe(false)
      expect(vNull.allowOfflineImport).toBe(true)

      const nonFiniteExpirySnapshot: LicenseSnapshot = {
        ...validOfflineSnapshot,
        expiresAt: Infinity
      }
      const vInf = computeEnvironmentVisibility(
        'production',
        true,
        nonFiniteExpirySnapshot,
        false,
        now
      )
      expect(vInf.isEnterpriseOffline).toBe(false)
      expect(vInf.allowOfflineImport).toBe(true)

      const nonEnterpriseSnapshot: LicenseSnapshot = {
        ...validOfflineSnapshot,
        tier: 'FREE'
      }
      const vFree = computeEnvironmentVisibility(
        'production',
        true,
        nonEnterpriseSnapshot,
        false,
        now
      )
      expect(vFree.isEnterpriseOffline).toBe(false)
      expect(vFree.allowOfflineImport).toBe(true)

      const unauthSnapshot: LicenseSnapshot = {
        ...validOfflineSnapshot,
        status: 'UNAUTHORIZED'
      }
      const vUnauth = computeEnvironmentVisibility('production', true, unauthSnapshot, false, now)
      expect(vUnauth.isEnterpriseOffline).toBe(false)
      expect(vUnauth.allowOfflineImport).toBe(true)

      const onlineSnapshot: LicenseSnapshot = {
        ...validOfflineSnapshot,
        normalizedType: 'ONLINE'
      }
      const vOnline = computeEnvironmentVisibility('production', true, onlineSnapshot, false, now)
      expect(vOnline.isEnterpriseOffline).toBe(false)
      expect(vOnline.allowOfflineImport).toBe(true)

      const canOfflineFalseSnapshot: LicenseSnapshot = {
        ...validOfflineSnapshot,
        canOffline: false
      }
      const vNoOffline = computeEnvironmentVisibility(
        'production',
        true,
        canOfflineFalseSnapshot,
        false,
        now
      )
      expect(vNoOffline.isEnterpriseOffline).toBe(false)
      expect(vNoOffline.allowOfflineImport).toBe(true)
    })
  })

  describe('resolveEnvironmentVisibility (Production Entry & Build Gate)', () => {
    beforeEach(() => {
      vi.unstubAllGlobals()
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('should throw Error in unpackaged development when __BUILD_CHANNEL__ is undefined', () => {
      vi.stubGlobal('__BUILD_CHANNEL__', undefined)
      expect(() => resolveEnvironmentVisibility(freeSnapshot, false, false, now)).toThrowError(
        /\[BuildGate\] __BUILD_CHANNEL__ is required in unpackaged development mode/
      )
    })

    it('should throw Error when __BUILD_CHANNEL__ is an invalid string', () => {
      vi.stubGlobal('__BUILD_CHANNEL__', 'invalid-channel' as unknown as BuildChannel)
      expect(() => resolveEnvironmentVisibility(freeSnapshot, false, false, now)).toThrowError(
        /\[BuildGate\] Invalid __BUILD_CHANNEL__ value: "invalid-channel"/
      )
    })

    it('should default to production in packaged environment when __BUILD_CHANNEL__ is undefined', () => {
      vi.stubGlobal('__BUILD_CHANNEL__', undefined)
      const visibility = resolveEnvironmentVisibility(validOfflineSnapshot, true, false, now)
      expect(visibility.isDev).toBe(false)
      expect(visibility.isEnterpriseOffline).toBe(true)
      expect(visibility.allowOfflineImport).toBe(true)
    })

    it('should respect __BUILD_CHANNEL__ = dev when unpackaged', () => {
      vi.stubGlobal('__BUILD_CHANNEL__', 'dev')
      const visibility = resolveEnvironmentVisibility(freeSnapshot, false, true, now)
      expect(visibility.isDev).toBe(true)
      expect(visibility.allowLocalPluginImport).toBe(true)
      expect(visibility.allowOfflineExport).toBe(true)
    })

    it('should respect __BUILD_CHANNEL__ = production even when unpackaged', () => {
      vi.stubGlobal('__BUILD_CHANNEL__', 'production')
      const visibility = resolveEnvironmentVisibility(freeSnapshot, false, true, now)
      expect(visibility.isDev).toBe(false)
      expect(visibility.allowLocalPluginImport).toBe(false)
      expect(visibility.allowOfflineExport).toBe(false)
    })

    it('should respect __BUILD_CHANNEL__ = staging', () => {
      vi.stubGlobal('__BUILD_CHANNEL__', 'staging')
      const visibility = resolveEnvironmentVisibility(freeSnapshot, false, true, now)
      expect(visibility.isDev).toBe(false)
    })
  })

  describe('EnvironmentVisibilityEnvelopeManager', () => {
    it('should generate random UUID epoch when constructor has no args', () => {
      const manager = new EnvironmentVisibilityEnvelopeManager()
      expect(manager.getEpoch()).toBeDefined()
      expect(manager.getEpoch().length).toBeGreaterThan(10)
    })

    it('should wrap visibility in envelope with increasing revisions and persistent epoch', () => {
      const manager = new EnvironmentVisibilityEnvelopeManager('test-fixed-epoch')
      expect(manager.getEpoch()).toBe('test-fixed-epoch')
      expect(manager.getRevision()).toBe(0)
      expect(manager.getCurrentEnvelope()).toBeNull()

      const v1 = computeEnvironmentVisibility('dev', false, freeSnapshot, true, now)
      const env1 = manager.wrap(v1)

      expect(env1.epoch).toBe('test-fixed-epoch')
      expect(env1.revision).toBe(1)
      expect(env1.visibility.isDev).toBe(true)
      expect(manager.getCurrentEnvelope()?.revision).toBe(1)

      const v2 = computeEnvironmentVisibility('production', true, freeSnapshot, false, now)
      const env2 = manager.wrap(v2)

      expect(env2.epoch).toBe('test-fixed-epoch')
      expect(env2.revision).toBe(2)
      expect(env2.visibility.isDev).toBe(false)
      expect(manager.getCurrentEnvelope()?.revision).toBe(2)
    })

    it('should prevent reference mutation on wrapped visibility', () => {
      const manager = new EnvironmentVisibilityEnvelopeManager('test-epoch')
      const mutableVis = computeEnvironmentVisibility('dev', false, freeSnapshot, true, now)
      const envelope = manager.wrap(mutableVis)

      // 验证返回只读冻结对象
      expect(Object.isFrozen(envelope.visibility)).toBe(true)
      // 尝试修改输入对象不影响内部缓存
      ;(mutableVis as unknown as { isDev: boolean }).isDev = false
      expect(manager.getCurrentEnvelope()?.visibility.isDev).toBe(true)
    })

    it('should track generation tickets to prevent async stale rollback', () => {
      const manager = new EnvironmentVisibilityEnvelopeManager('async-epoch')
      const t1 = manager.acquireTicket() // 慢速异步任务开始 (例如刷新授权)
      const t2 = manager.acquireTicket() // 快速同步切换 (例如切换开发者模式)

      const v2 = computeEnvironmentVisibility('dev', false, freeSnapshot, true, now)
      const env2 = manager.wrap(v2, t2)
      expect(env2.revision).toBe(1)
      expect(env2.visibility.developerModeEnabled).toBe(true)

      // 迟到的旧任务完成 (t1 < t2)，调用 wrap
      const v1 = computeEnvironmentVisibility('dev', false, freeSnapshot, false, now)
      const staleResult = manager.wrap(v1, t1)

      // 断言 revision 不推进，且状态仍然保持最新的 v2，杜绝回退
      expect(staleResult.revision).toBe(1)
      expect(staleResult.visibility.developerModeEnabled).toBe(true)
      expect(manager.getCurrentEnvelope()?.visibility.developerModeEnabled).toBe(true)

      // 显式传入更高代际的 ticket (ticket > lastTicket)
      const futureTicket = 99
      const v3 = computeEnvironmentVisibility('dev', false, freeSnapshot, false, now)
      const env3 = manager.wrap(v3, futureTicket)
      expect(env3.revision).toBe(2)
      expect(env3.visibility.developerModeEnabled).toBe(false)
    })
  })
})
