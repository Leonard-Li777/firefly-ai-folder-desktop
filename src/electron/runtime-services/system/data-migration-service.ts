import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { logger, LogCategory } from '@firefly/shared'
import { SystemIdentityService } from '../system/system-identity-service'
import { invitationService } from '../invitation/invitation-service'

export class DataMigrationService {
  private static instance: DataMigrationService

  static getInstance() {
    if (!this.instance) {
      this.instance = new DataMigrationService()
    }
    return this.instance
  }

  async migrate() {
    const orchestrator = ConfigOrchestrator.getInstance()
    const tc = orchestrator.getTierConstants()
    const migrationCompleted = orchestrator.getValue<boolean>('MIGRATION_COMPLETED')

    // 我们检查一个特定的迁移版本标识，如果已经迁移过则跳过
    const migrationVersion = orchestrator.getValue<string>('MIGRATION_VERSION')
    if (migrationVersion === '1.0.1-tier-migration') {
      return
    }

    logger.info(LogCategory.SYSTEM, '[Migration] Starting user tier and firecore migration...')

    try {
      // 1. 获取旧数据：优先从云端拉取，拉取失败再回退至本地缓存
      let invitationCount = 0
      try {
        // invitationService 已在顶部静态导入
        const cloudQuota = await invitationService.getInvitationQuota()
        if (cloudQuota && !cloudQuota.isFromCache) {
          invitationCount = cloudQuota.count
          logger.info(
            LogCategory.SYSTEM,
            `[Migration] Cloud invitation count fetched: ${invitationCount}`
          )
        } else {
          const invitationCache = orchestrator.getValue<any>('INVITATION_CACHE_DATA')
          invitationCount = invitationCache?.invitationCount || 0
          logger.info(
            LogCategory.SYSTEM,
            `[Migration] Fallback to local cache invitation count: ${invitationCount}`
          )
        }
      } catch (err) {
        const invitationCache = orchestrator.getValue<any>('INVITATION_CACHE_DATA')
        invitationCount = invitationCache?.invitationCount || 0
        logger.warn(
          LogCategory.SYSTEM,
          '[Migration] Failed to query cloud invitation count, fallback to local cache:',
          err
        )
      }

      const machineId = SystemIdentityService.getInstance().getMachineId()
      const { databaseService } = await import('../database/database-service')
      const db = databaseService.db
      if (db) {
        const crypto = require('crypto')
        const getDeterministicUUID = (seed: string): string => {
          const hash = crypto.createHash('sha256').update(seed).digest('hex')
          return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`
        }

        // 2. 历史邀请赠币
        if (invitationCount > 0) {
          const existingInvites = db
            .prepare(
              "SELECT COUNT(*) as count FROM pending_firecore_operations WHERE operation_type = 'invitation_earn'"
            )
            .get() as { count: number }
          const missingInvites = invitationCount - (existingInvites?.count || 0)
          for (let i = 0; i < missingInvites; i++) {
            const inviteTxId = getDeterministicUUID(machineId + '_invitation_earn_' + i)
            const hasInvite = db
              .prepare('SELECT id FROM pending_firecore_operations WHERE id = ? LIMIT 1')
              .get(inviteTxId)
            if (!hasInvite) {
              db.prepare(
                `INSERT INTO pending_firecore_operations (id, operation_type, payload, local_state_before, status, created_at)
                 VALUES (?, ?, ?, ?, 'pending', ?)`
              ).run(
                inviteTxId,
                'invitation_earn',
                JSON.stringify({ type: 'invitation_earn', firecores: tc.inviteFirecoreReward }),
                JSON.stringify({}),
                new Date().toISOString()
              )
            }
          }
        }

        // 3. 历史解锁扣币 (如果有)
        if (invitationCount >= 3) {
          const unlockTxId = getDeterministicUUID(machineId + '_spend_unlock_analysis')
          const hasUnlock = db
            .prepare(
              "SELECT id FROM pending_firecore_operations WHERE operation_type = 'spend_unlock_analysis' OR id = ? LIMIT 1"
            )
            .get(unlockTxId)
          if (!hasUnlock) {
            db.prepare(
              `INSERT INTO pending_firecore_operations (id, operation_type, payload, local_state_before, status, created_at)
               VALUES (?, ?, ?, ?, 'pending', ?)`
            ).run(
              unlockTxId,
              'spend_unlock_analysis',
              JSON.stringify({
                type: 'spend_unlock_analysis',
                firecores: tc.prices.spend_unlock_analysis
              }),
              JSON.stringify({}),
              new Date().toISOString()
            )
          }
        }
      }

      // 4. 清理旧数据标志
      await orchestrator.updateValue('IS_PRIVATE_DIRECTORY_UNLOCKED', false)
      await orchestrator.updateValue('MIGRATION_VERSION', '1.0.1-tier-migration')
      await orchestrator.updateValue('MIGRATION_COMPLETED', true)

      logger.info(
        LogCategory.SYSTEM,
        '[Migration] User tier and firecore migration completed successfully.'
      )
    } catch (e) {
      logger.error(LogCategory.SYSTEM, '[Migration] Migration failed:', e)
    }
  }
}

export const dataMigrationService = DataMigrationService.getInstance()
