import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { logger, LogCategory } from '@firefly/shared'
import { SystemIdentityService } from '../system/system-identity-service'

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
    const migrationCompleted = orchestrator.getValue<boolean>('MIGRATION_COMPLETED')

    // 我们检查一个特定的迁移版本标识，如果已经迁移过则跳过
    const migrationVersion = orchestrator.getValue<string>('MIGRATION_VERSION')
    if (migrationVersion === '1.0.1-tier-migration') {
      return
    }

    logger.info(LogCategory.SYSTEM, '[Migration] Starting user tier and firecore migration...')

    try {
      void SystemIdentityService.getInstance().getMachineId() // machineId 保留供云端迁移 RPC 定向补发历史流水（Issue 05 Step 2）

      // Issue 05 Step 2：退役端侧正数写入（Cloud Authority for Entitlements 红线）。
      // 旧版在此向 pending_firecore_operations 本地合成 invitation_earn（正数）与
      // spend_unlock_analysis（旧列 payload/local_state_before），新创世基线已施加
      // CHECK (operation_type GLOB 'spend_*' AND amount_delta <= 0) 物理封锁端侧自铸萤火。
      // 历史邀请奖励与解锁扣币均改由云端 SSOT 入账：绑定/注册 RPC 原子写入云端流水，
      // 端侧经 trySync 镜像 firecore_transactions_cache 只读下发，严禁端侧补写任何正数流水。
      // 此处仅落迁移完成标志，跳过全部本地合成。

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
