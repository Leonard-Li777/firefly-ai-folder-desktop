/**
 * 同步 I/O 白名单登记表（infra/fs）
 *
 * 用途：ratchet 门禁（`apps/desktop/scripts/check-sync-io-ratchet.mjs`，见 ticket 05）判定
 * 「新文件/新增调用点的同步 I/O 是否被豁免」时，唯一采信的事实源。没有登记的同步 I/O 一律视为违规。
 *
 * 铁律（AGENTS.md §2 / spec INV-6）：
 * - 只允许登记「窗口创建前必须完成」或「进程正在消失、异步来不及」两类保留；
 * - 每条必须写明 `ticket`（关联工单号）、`reason`（为什么非同步不可）与 `removalCondition`（什么条件下必须移除），
 *   空字段即视为违规——没有工单追溯与移除条件的豁免会永久化；
 * - 废止大入口 `<module-scope>` 整文件顶层豁免：必须按精确具名同步函数 `file + function` 登记；
 * - **键归一化只用于登记表匹配**：这里的 `file` 是登记键，不是文件系统路径。
 *   严禁把归一化结果用于 `fs` 调用、`isPathEqual` / `isSubPath` 或 SQL `WHERE path`
 *   （AGENTS.md §2 路径红线：比较层不得做分隔符转换）。
 */

export interface SyncAllowlistEntry {
  /** 仓库根相对路径，使用正斜杠，例如 `apps/desktop/src/electron/main/index.ts` */
  file: string
  /** 精确具名函数名（禁止使用宽泛 `<module-scope>` 整文件顶层豁免） */
  function: string
  /** 关联工单编号（如 `'J-05 / IO-23'`、`'IO-11 / P1-5'`），用于审计追溯 */
  ticket: string
  /** 为什么必须保留同步（一句话说清约束来源） */
  reason: string
  /** 什么条件下必须移除该豁免，并指向后续工单/ADR */
  removalCondition: string
}

/**
 * 已决断的保留项。
 *
 * 追加规则：先在本工单对应的 spec 条目里写清理由，再在此按 `file + function + ticket + reason + removalCondition` 登记，最后由 ticket 05 的 ratchet 采信。
 */
export const SYNCHRONOUS_ALLOWLIST: readonly SyncAllowlistEntry[] = [
  {
    file: 'apps/desktop/src/electron/main/index.ts',
    function: 'migrateLegacyUserDataSync',
    ticket: 'J-05 / IO-23',
    reason:
      '旧目录迁移（yonuc-ai-folder → 新版 userData）在模块求值期执行，必须早于 app.ready 与 ConfigOrchestrator 读取；放到 worker 会让配置拷贝晚于配置读取（INV-6 / J-05 / IO-23，对应总路线图 §7.3 首启迁移 >200ms 同步阻塞豁免口径）',
    removalCondition:
      '仅当引入「迁移前置就绪屏障」并整体重排 ConfigOrchestrator 读取时序时移除，届时须新增 ADR 并改写初始化铁律'
  },
  {
    file:
      'apps/desktop/src/electron/runtime-services/engine-bridge/engine-bridge-service/engine-bridge-service.ts',
    function: 'killOwnProcess',
    ticket: 'IO-11 / P1-5',
    reason:
      '热部署路径依赖「返回即旧进程树已终止」后再用同端口拉起；且引擎自启/热部署用例按源码文本断言该方法签名（P1-5 / R3 决断，本期保持同步）',
    removalCondition:
      '待 M0 插桩排行证明该点为实际瓶颈后单独立项改造，届时同步改写 engine-service-autostart-wiring / engine-deploy-restart-avoidance 两处断言'
  },
  {
    file: 'apps/desktop/src/electron/main/index.ts',
    function: 'flushLogsBeforeExit',
    ticket: 'IO-07 / P0-12',
    reason:
      '主进程单实例拒绝、初始化失败、退出超时、before-quit 与终止信号这 6 处 app.exit/process.exit 前同步刷出最后日志，进程即将销毁异步队列来不及落盘（INV-6 / IO-07）',
    removalCondition: '仅当改为独立守护进程接管日志落盘且不再依赖主进程同步尾刷时移除'
  },
  {
    file: 'apps/desktop/src/electron/runtime-services/system/logging-service.ts',
    function: 'handleProcessExitFlush',
    ticket: 'IO-07 / P0-12',
    reason:
      'process.on("exit") 触发时 Node 事件循环已不再驱动异步 I/O，仅允许通过同步尾刷保存未确认日志批次与缓冲（INV-6 / IO-07）',
    removalCondition: '仅当日志写入迁出主进程到独立常驻守护进程后移除'
  },
  {
    file: 'apps/desktop/src/electron/main/perf-flags.ts',
    function: 'readPerfFlagsSnapshotSync',
    ticket: 'TM-W2 / B8',
    reason:
      '窗口 additionalArguments 在 bootstrap 期配置库尚不可读时必须同步拿到 perf-flags 快照（<userData>/perf-flags.json 容错读，预算 <10ms；INV-6 / [V-01]，启动性能计划 §10.3）',
    removalCondition:
      'W3 启动分层落地、窗口创建整体后移至配置就绪屏障之后（additionalArguments 改由 ConfigOrchestrator 异步快照供给）时移除'
  },
  {
    file: 'apps/desktop/src/electron/main/perf-flags.ts',
    function: 'getPerfFlagsSnapshot',
    ticket: 'TM-W2 / B8',
    reason:
      '缓存包装仅首次调用透传 readPerfFlagsSnapshotSync 的启动前同步读（4 处窗口创建共用同一快照），无独立新增同步 I/O（INV-6 / [V-01]）',
    removalCondition: '随 readPerfFlagsSnapshotSync 豁免一并移除（W3 窗口创建后移至配置就绪屏障之后）'
  }
  // 后续工单预留登记规范（不在本工单范围，须在对应工单落地时按 `file + function + ticket + reason + removalCondition` 正式入表）：
  // - W3 `J-06`（`apps/desktop/src/electron/main/process-reaper.ts`）：当前退出 `cleanup()` → `killVerified(..., 'fast')`
  //   与启动深校验 `cleanupStaleProcesses()` → `killVerified(..., 'deep')` 共用同一函数，按 `file:function` 登记会把启动路径一并豁免，
  //   与「启动阶段改异步」直接冲突。须待拆出独立退出同步函数（含 `writeFileAtomicSync` 退出写盘）后再精确入表（见 ADR-0075 决策 4 / ticket 23）。
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
    const ticket = entry.ticket?.trim() ?? ''
    const reason = entry.reason?.trim() ?? ''
    const removalCondition = entry.removalCondition?.trim() ?? ''

    if (!file) problems.push('存在未填写 file 的登记项')
    if (file.startsWith('.') || file.startsWith('/') || /^[A-Za-z]:\//.test(file)) {
      problems.push(`登记键必须是仓库根相对路径: ${entry.file}`)
    }
    if (!functionName) {
      problems.push(`登记项缺少 function: ${entry.file}`)
    } else if (functionName === '<module-scope>') {
      problems.push(`禁止使用宽泛 <module-scope> 豁免，必须提取为精确具名同步函数: ${file}`)
    }
    if (!ticket) problems.push(`登记项缺少 ticket（必须关联工单号）: ${file}:${functionName}`)
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
