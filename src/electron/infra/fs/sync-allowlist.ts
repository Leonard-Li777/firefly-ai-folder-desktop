/**
 * 同步 I/O 白名单登记表（infra/fs）
 *
 * 用途：ratchet 门禁（`apps/desktop/scripts/check-sync-io-ratchet.mjs`，见 ticket 05）判定
 * 「新文件/新增调用点的同步 I/O 是否被豁免」时，唯一采信的事实源。没有登记的同步 I/O 一律视为违规。
 *
 * 铁律（AGENTS.md §2 / spec INV-6）：
 * - 只允许登记「窗口创建前必须完成」或「进程正在消失、异步来不及」两类保留；
 * - 每条必须写明 `reason`（为什么非同步不可）与 `removalCondition`（什么条件下必须移除），
 *   空字段即视为违规——没有移除条件的豁免会永久化；
 * - **键归一化只用于登记表匹配**：这里的 `file` 是登记键，不是文件系统路径。
 *   严禁把归一化结果用于 `fs` 调用、`isPathEqual` / `isSubPath` 或 SQL `WHERE path`
 *   （AGENTS.md §2 路径红线：比较层不得做分隔符转换）。
 */

export interface SyncAllowlistEntry {
  /** 仓库根相对路径，使用正斜杠，例如 `apps/desktop/src/electron/main/index.ts` */
  file: string
  /** 函数名；模块顶层代码统一写作 `<module-scope>`（AST 侧无法给出具名帧） */
  function: string
  /** 为什么必须保留同步（一句话说清约束来源） */
  reason: string
  /** 什么条件下必须移除该豁免，并指向后续工单/ADR */
  removalCondition: string
}

/**
 * 已决断的保留项（M0 初版）。
 *
 * 追加规则：先在本工单对应的 spec 条目里写清理由，再在此登记，最后由 ticket 05 的 ratchet 采信。
 */
export const SYNCHRONOUS_ALLOWLIST: readonly SyncAllowlistEntry[] = [
  {
    file: 'apps/desktop/src/electron/main/index.ts',
    function: '<module-scope>',
    reason:
      '旧目录迁移（yonuc-ai-folder → 新版 userData）在模块求值期执行，必须早于 app.ready 与 ConfigOrchestrator 读取；放到 worker 会让配置拷贝晚于配置读取（INV-6 / P1-1 决断）',
    removalCondition:
      '仅当引入「迁移前置就绪屏障」并整体重排 ConfigOrchestrator 读取时序时移除，届时须新增 ADR 并改写初始化铁律'
  },
  {
    file:
      'apps/desktop/src/electron/runtime-services/engine-bridge/engine-bridge-service/engine-bridge-service.ts',
    function: 'killOwnProcess',
    reason:
      '热部署路径依赖「返回即旧进程树已终止」后再用同端口拉起；且引擎自启/热部署用例按源码文本断言该方法签名（P1-5 / R3 决断，本期保持同步）',
    removalCondition:
      '待 M0 插桩排行证明该点为实际瓶颈后单独立项改造，届时同步改写 engine-service-autostart-wiring / engine-deploy-restart-avoidance 两处断言'
  }
  // 待登记（不在本工单范围，避免提前豁免错的粒度）：
  // - `apps/desktop/src/electron/main/process-reaper.ts` 的退出阶段 taskkill：当前 `killVerified(..., 'fast')`
  //   与启动深校验 `killVerified(..., 'deep')` 共用同一函数，按 `file:function` 登记会把启动路径一并豁免，
  //   与 P1-4「启动阶段改异步」直接冲突。必须等 ticket 11 拆出独立退出函数后再登记（见 ticket 23）。
]

/**
 * 登记键归一化：仅把分隔符统一为正斜杠并去掉 `./` 前缀。
 *
 * 只服务登记表匹配，绝不参与文件系统访问或路径相等比较（见文件头铁律）。
 */
export function normalizeRegistryKey(file: string): string {
  return file
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
}

/** 查找登记项（未命中返回 undefined；调用方据此判定违规） */
export function findSyncAllowlistEntry(
  file: string,
  functionName: string
): SyncAllowlistEntry | undefined {
  const key = normalizeRegistryKey(file)
  return SYNCHRONOUS_ALLOWLIST.find(
    entry => normalizeRegistryKey(entry.file) === key && entry.function === functionName
  )
}

/**
 * 校验登记表完整性，返回人类可读的违规清单（空数组 = 合规）。
 *
 * 暴露为纯函数以便单测直接喂入坏数据；`assertSyncAllowlistIntegrity` 只是对模块表的封装。
 */
export function validateSyncAllowlist(entries: readonly SyncAllowlistEntry[]): string[] {
  const problems: string[] = []
  const seen = new Map<string, number>()

  for (const entry of entries) {
    const file = normalizeRegistryKey(entry.file ?? '')
    const functionName = entry.function?.trim() ?? ''
    const reason = entry.reason?.trim() ?? ''
    const removalCondition = entry.removalCondition?.trim() ?? ''

    if (!file) problems.push('存在未填写 file 的登记项')
    if (file.startsWith('.') || file.startsWith('/') || /^[A-Za-z]:\//.test(file)) {
      problems.push(`登记键必须是仓库根相对路径: ${entry.file}`)
    }
    if (!functionName) problems.push(`登记项缺少 function: ${entry.file}`)
    if (!reason) problems.push(`登记项缺少 reason（无理由豁免等于永久豁免）: ${file}:${functionName}`)
    if (!removalCondition) {
      problems.push(`登记项缺少 removalCondition（没有移除条件的豁免会永久化）: ${file}:${functionName}`)
    }

    const key = `${file}:${functionName}`
    const count = (seen.get(key) ?? 0) + 1
    seen.set(key, count)
    if (count > 1) problems.push(`登记键重复: ${key}`)
  }

  return problems
}

/** 校验模块登记表，违规即抛出（供 CI / 单测调用） */
export function assertSyncAllowlistIntegrity(): void {
  const problems = validateSyncAllowlist(SYNCHRONOUS_ALLOWLIST)
  if (problems.length > 0) {
    throw new Error(`同步 I/O 白名单不合规:\n- ${problems.join('\n- ')}`)
  }
}

/** 只读导出，避免调用方直接改模块级数组 */
export function listSyncAllowlistEntries(): readonly SyncAllowlistEntry[] {
  return SYNCHRONOUS_ALLOWLIST
}
