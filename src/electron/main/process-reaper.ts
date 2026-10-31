import * as fs from 'node:fs'
import * as path from 'node:path'
import { app } from 'electron'
import { spawnSync } from 'child_process'
import { logger, LogCategory, isPathEqual } from '@firefly/shared'

interface PidRecord {
  pid: number
  name: string
  createdAt: number
  /**
   * 进程可执行文件名（如 firefly-omni.exe），杀前身份校验的第一道闸。
   *
   * PID 是会被系统复用的整数：应用异常退出留下 runtime-pids.json，用户隔天再启动时，
   * 记录里的 PID 很可能已经属于一个完全无关的进程（explorer.exe / 浏览器 / 用户自己的程序）。
   * 旧实现直接 `taskkill /F /T /PID`，等于按号码随机强杀，存在真实的误杀风险。
   * 因此登记时记下可执行文件名，杀前比对当前该 PID 的进程名，不一致就拒绝清理。
   */
  exeName?: string
  /**
   * 可执行文件完整路径（可选，登记方提供时才有）。
   * 仅比对文件名挡不住「同名不同程序」：本仓库多 worktree 并发开发时，
   * 每个 worktree 都会跑一份同名的 firefly-omni.exe / firefly-ai-engine.exe，
   * 只有路径才能区分「自己的」和「别人的」。
   */
  exePath?: string
}

/** 单条进程身份快照 */
interface ProcIdentity {
  pid: number
  /** 进程可执行文件名（含扩展名） */
  name: string
  /** 可执行文件完整路径，深度查询时才有值 */
  exePath: string
  /** 进程实际启动时间（毫秒时间戳），0 表示未知 */
  startedAtMs: number
}

/**
 * PID 复用容差。
 * 深度校验时若进程实际启动时间晚于登记时间超过该阈值，说明该 PID 上的进程是
 * 「登记之后才诞生」的同名新进程（原进程早已退出、号码被回收），不应清理。
 */
const PID_REUSE_TOLERANCE_MS = 60_000

/** 单次系统查询的超时上限，避免退出钩子里卡死 */
const QUERY_TIMEOUT_MS = 8_000

/**
 * 深度查询（PowerShell CIM）较慢，但它是**同步**执行的，且发生在应用启动路径上，
 * 超时上限直接等于用户可感知的「双击没反应」时长，因此必须压到秒级。
 */
const DEEP_QUERY_TIMEOUT_MS = 6_000

/**
 * 由逻辑名推导可执行文件名。
 * 登记方显式传入 exeName 时以其为准（如 LibreOffice 的逻辑名是 LibreOffice-Daemon，
 * 但真实可执行文件是 soffice.bin）；否则按 Windows 习惯补 .exe 后缀。
 */
const deriveExeName = (name: string, exeName?: string): string => {
  if (exeName && exeName.trim()) return path.basename(exeName.trim())
  if (process.platform !== 'win32') return name
  return /\.exe$/i.test(name) ? name : `${name}.exe`
}

/**
 * 校验并规范化从磁盘读到的记录。
 *
 * runtime-pids.json 的内容完全来自磁盘，必须当作不可信输入：
 * pid 会被拼进 PowerShell 的 `-Filter "ProcessId=N"`，若 pid 是含引号的字符串，
 * 就能闭合引号改写整条命令；脏数据（pid 为 0 / 小数 / 字符串）也会让校验逻辑失效。
 */
const sanitizeRecords = (raw: unknown): PidRecord[] => {
  if (!Array.isArray(raw)) return []
  const out: PidRecord[] = []
  for (const item of raw) {
    const source = item as Partial<PidRecord> | null | undefined
    const pid = Number(source?.pid)
    if (!Number.isInteger(pid) || pid <= 0) continue
    out.push({
      pid,
      name: typeof source?.name === 'string' ? source.name : `pid-${pid}`,
      createdAt: Number(source?.createdAt) || 0,
      exeName: typeof source?.exeName === 'string' ? source.exeName : undefined,
      exePath: typeof source?.exePath === 'string' ? source.exePath : undefined
    })
  }
  return out
}

/**
 * 进程名是否匹配。
 *
 * Windows 下 tasklist 返回完整文件名，直接大小写不敏感比较即可。
 * Linux 的 `ps -o comm=` 会被内核截断到 15 字符（TASK_COMM_LEN），
 * 超过长度的进程名只会留下前缀 —— 此时按前缀匹配，否则长名字的进程永远校验不过、
 * 永远拒绝清理，孤儿进程会一直常驻。
 */
const isNameMatch = (expected: string, actual: string): boolean => {
  const e = expected.toLowerCase()
  const a = actual.toLowerCase()
  if (e === a) return true
  if (process.platform !== 'win32' && a.length >= 15 && e.startsWith(a)) return true
  return false
}

/**
 * 解析 .NET / PowerShell 序列化出来的时间。
 * PowerShell 5.1 的 ConvertTo-Json 会把 DateTime 序列化成 "\/Date(1697961000000)\/"，
 * 而 PowerShell 7 会序列化成 ISO 字符串，两种都要兼容。
 */
const parseSerializedDate = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const raw = String(value ?? '')
  const msMatch = raw.match(/\/Date\((-?\d+)/)
  if (msMatch) return Number(msMatch[1])
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * 轻量身份查询：只查指定 PID 的进程名。
 *
 * 为什么不做全表枚举（旧实现用 `tasklist /FO CSV /NH` 一次拉全表）：
 * tasklist 的全表查询、乃至 `/FI "IMAGENAME eq xxx"` 镜像名过滤，都要**遍历系统中
 * 每一个进程**再去过滤；一旦机器上存在卡死的进程、或装了会 hook 进程枚举的 EDR/杀软，
 * 单次调用可能数十秒不返回（实测某机器上 >30s 仍不退出）。
 * 而本函数在退出钩子里是**同步**调用的 —— 那会把「退出应用」直接变成「应用卡死」，
 * 超时后还会被判定为「查询能力不可用」，导致所有子进程都不清理、全部变孤儿。
 *
 * 改用按 PID 定向查询后，耗时与系统进程总数无关：Windows 走一次 PowerShell
 * `Get-Process -Id`（不枚举全表），POSIX 走 `ps -p <pids>`。
 *
 * @returns 查询失败（命令不可用 / 超时）时返回 null，调用方据此拒绝盲杀
 */
const queryProcessNames = (pids: number[]): Map<number, string> | null => {
  if (pids.length === 0) return new Map()
  const map = new Map<number, string>()
  try {
    if (process.platform === 'win32') {
      const script =
        `$ErrorActionPreference='SilentlyContinue';` +
        `Get-Process -Id ${pids.join(',')} | ` +
        `Select-Object Id,ProcessName,Path | ConvertTo-Json -Compress`
      const res = spawnSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        {
          encoding: 'utf8',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: QUERY_TIMEOUT_MS
        }
      )
      if (res.error) return null
      // 非 0 退出 = 查询失败（执行策略拦截 / PowerShell 不可用），必须拒绝盲杀
      if (res.status !== 0) return null
      // 全部 PID 都不存在时无输出，属于「查到了，没有」
      if (!res.stdout || !res.stdout.trim()) return map
      const parsed = JSON.parse(res.stdout.trim())
      const rows = Array.isArray(parsed) ? parsed : [parsed]
      for (const row of rows) {
        const pid = Number(row?.Id)
        if (!pid) continue
        // ProcessName 不带扩展名（firefly-omni），而登记值是带扩展名的文件名。
        // 优先用 Path 的 basename 拿到真实文件名（如 soffice.bin），
        // 拿不到（受保护进程 / 权限不足）时才退回「ProcessName + .exe」。
        const exePath = String(row?.Path ?? '')
        const procName = String(row?.ProcessName ?? '')
        if (!procName) continue
        map.set(pid, exePath ? path.basename(exePath) : `${procName}.exe`)
      }
      return map
    }

    const res = spawnSync('ps', ['-p', pids.join(','), '-o', 'pid=,comm='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: QUERY_TIMEOUT_MS
    })
    if (res.error) return null
    // ps -p <不存在的 pid> 可能以非 0 退出且无输出，属于「查到了，没有」
    if (!res.stdout || !res.stdout.trim()) return map
    if (res.status !== 0) return null
    for (const line of res.stdout.split(/\r?\n/)) {
      // comm 是最后一列：macOS 下它是含空格的完整路径，必须贪婪匹配
      const m = line.trim().match(/^(\d+)\s+(.+)$/)
      if (m) map.set(Number(m[1]), path.basename(m[2].trim()))
    }
    return map
  } catch {
    return null
  }
}

/**
 * 深度身份查询：取回进程名 + 可执行文件路径 + 实际启动时间。
 * 只在启动阶段的存量清理中使用（一次调用、可接受数百毫秒开销）。
 * @returns 查询失败时返回 null
 */
const queryProcessIdentities = (pids: number[]): Map<number, ProcIdentity> | null => {
  if (pids.length === 0) return new Map()
  try {
    if (process.platform === 'win32') {
      const filter = pids.map(p => `ProcessId=${p}`).join(' or ')
      const script =
        `$ErrorActionPreference='SilentlyContinue';` +
        `Get-CimInstance Win32_Process -Filter "${filter}" | ` +
        `Select-Object ProcessId,Name,ExecutablePath,CreationDate | ConvertTo-Json -Compress`
      const res = spawnSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        {
          encoding: 'utf8',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: DEEP_QUERY_TIMEOUT_MS
        }
      )
      if (res.error) return null
      // 顺序很重要：PowerShell 命中 0 条时以 0 退出且输出为空（「查到了，没有」），
      // 而非 0 退出 + 空输出是真正的查询失败（执行策略拦截 / CIM 服务异常）。
      // 若先判空输出，后者会被误判成「进程已退出」→ 孤儿进程被静默留下且不报警。
      if (res.status !== 0) return null
      if (!res.stdout || !res.stdout.trim()) return new Map()
      const parsed = JSON.parse(res.stdout.trim())
      const rows = Array.isArray(parsed) ? parsed : [parsed]
      const map = new Map<number, ProcIdentity>()
      for (const row of rows) {
        const pid = Number(row?.ProcessId)
        if (!pid) continue
        map.set(pid, {
          pid,
          name: String(row?.Name ?? ''),
          exePath: String(row?.ExecutablePath ?? ''),
          startedAtMs: parseSerializedDate(row?.CreationDate)
        })
      }
      return map
    }

    // 非 Windows：用 ps 取进程名与绝对启动时间；Linux 再补 /proc/<pid>/exe
    // 用 lstart（绝对时间）而不是 etimes（已运行秒数）：macOS 的 BSD ps 不支持 etimes，
    // 命令会直接报错，导致深度校验在 macOS 上恒失败。
    //
    // 列序必须是 pid → lstart → comm：macOS 的 comm 是**含空格的完整路径**
    // （/Applications/Firefly AI.app/Contents/...），若放在中间，`\S+` 只吃到第一个空格
    // 就断，路径后半段会被当成 lstart 解析，进程名与启动时间双双错误。
    // 把 comm 放最后一列才能贪婪匹配整段路径。
    const res = spawnSync('ps', ['-p', pids.join(','), '-o', 'pid=,lstart=,comm='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: DEEP_QUERY_TIMEOUT_MS
    })
    if (res.error) return null
    // ps -p <不存在的 pid> 会以非 0 退出且无输出，这属于「查到了，没有」，不是查询失败
    if (!res.stdout || !res.stdout.trim()) return new Map()
    if (res.status !== 0) return null
    const map = new Map<number, ProcIdentity>()
    for (const line of res.stdout.split(/\r?\n/)) {
      // lstart 是 ctime 风格的五段式：`Sat Oct 24 09:00:00 2026`。
      // 按「固定 5 个空白分隔 token」切分，避免依赖 locale 的具体措辞。
      // 形如 "1234 Sat Oct 24 09:00:00 2026 /Applications/Firefly AI.app/.../firefly-omni"
      const m = line.trim().match(/^(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/)
      if (!m) continue
      const pid = Number(m[1])
      let exePath = ''
      try {
        exePath = fs.readlinkSync(`/proc/${pid}/exe`)
      } catch {
        // macOS 无 /proc，路径留空即可，不影响进程名与启动时间校验
      }
      map.set(pid, {
        pid,
        name: path.basename(m[3].trim()),
        exePath,
        // 解析失败记 0（未知），后续据此跳过启动时间校验，而不是误判
        startedAtMs: Number.isFinite(Date.parse(m[2])) ? Date.parse(m[2]) : 0
      })
    }
    return map
  } catch {
    return null
  }
}

/**
 * 全局进程守护与精准防孤儿清理器 (ProcessReaper)
 * 负责记录本 worktree 实例名下的子进程 PID，并在退出/启动前定向清理，杜绝孤儿进程与跨 worktree 误杀。
 *
 * 关键不变量：`this.pids` 只装**本进程自己拉起**的子进程，绝不从磁盘加载历史记录。
 *
 * 原因：`runtime-pids.json` 里的记录可能是「另一个正在运行的实例」的活子进程
 * （登记发生在 spawn 之后，进程存活期间就会写盘）。若把它读进内存，第二个实例
 * 在单实例锁判定失败后 `process.exit(0)` 会触发 exit 钩子 → cleanup() → 按记录
 * 把第一个实例的引擎全部杀掉。历史记录只由 cleanupStaleProcesses() 在拿到单实例锁
 * 之后单独处理。
 *
 * 所有清理动作都必须先通过身份校验（见 killVerified），校验不通过一律拒绝清理：
 * 留下一个孤儿进程只会浪费内存，误杀一个无关进程却可能直接毁掉用户正在做的事。
 */
export class ProcessReaper {
  private static instance: ProcessReaper
  private pids: Map<number, PidRecord> = new Map()
  private lockFilePath = ''
  private isCleanedUp = false
  /**
   * 本实例是否真的登记过子进程。
   *
   * 决定退出时要不要回写 runtime-pids.json。第二个实例拿不到单实例锁会 `process.exit(0)`，
   * 同样触发 exit 钩子 → cleanup()；此时它的 `pids` 是空的，若无条件 persist 就会把文件
   * 覆写成 `[]`，抹掉**正在运行的那个实例**的记录 —— 那个实例下次异常退出后，
   * 它的引擎/omni 子进程就再也没有记录可查，直接变成永久孤儿。
   */
  private hasOwnedRecords = false

  private constructor() {
    try {
      const userData = app.getPath('userData')
      this.lockFilePath = path.join(userData, 'runtime-pids.json')
      this.registerExitHooks()
    } catch (err) {
      // ignore in test
    }
  }

  public static getInstance(): ProcessReaper {
    if (!ProcessReaper.instance) {
      ProcessReaper.instance = new ProcessReaper()
    }
    return ProcessReaper.instance
  }

  /**
   * 注册受保护的子进程 PID
   * @param pid 子进程 PID
   * @param name 逻辑名（用于日志与展示）
   * @param exeName 真实可执行文件名，缺省时按逻辑名推导；杀前身份校验依赖它
   * @param exePath 真实可执行文件完整路径（可选）。深度校验时用它区分「同名不同程序」，
   *   例如多个 worktree 各跑一份 firefly-omni.exe —— 仅比对文件名会把别人的进程杀掉。
   */
  public registerChild(
    pid: number | undefined,
    name: string,
    exeName?: string,
    exePath?: string
  ): void {
    if (!pid || pid <= 0) return
    this.hasOwnedRecords = true
    this.pids.set(pid, {
      pid,
      name,
      createdAt: Date.now(),
      exeName: deriveExeName(name, exeName),
      exePath: exePath ? path.resolve(exePath) : undefined
    })
    this.persistPids()
    logger.info(LogCategory.SYSTEM, `[ProcessReaper] 已登记子进程: ${name} (PID: ${pid})`)
  }

  /**
   * 注销已正常退出的子进程
   */
  public unregisterChild(pid: number | undefined): void {
    if (!pid) return
    if (this.pids.delete(pid)) {
      this.persistPids()
    }
  }

  /**
   * 清理属于本 Worktree 实例的所有子进程
   */
  public cleanup(): void {
    if (this.isCleanedUp) return
    this.isCleanedUp = true

    logger.info(LogCategory.SYSTEM, '[ProcessReaper] 正在执行子进程资源回收...')

    const records = Array.from(this.pids.values())
    // 退出钩子里必须保持同步且轻量：全表查询只做一次，绝不按记录条数重复 spawn 系统命令
    const identities = records.length > 0 ? this.resolveIdentities(records, 'fast') : null
    for (const record of records) {
      this.killVerified(record, identities, 'fast')
    }
    this.pids.clear()

    // 只有「本实例确实拥有过记录」时才回写。
    // 否则第二个实例的退出会把文件覆写成 []，抹掉正在运行实例的登记（详见 hasOwnedRecords）。
    if (this.hasOwnedRecords) {
      this.persistPids()
    }
  }

  /**
   * 启动前回收本 Worktree 历史遗留的僵尸子进程。
   *
   * 这是 PID 复用误杀风险最高的场景：记录来自上一次运行，可能已是数天前，
   * 其中的 PID 大概率已被系统分配给别的进程。因此这里走深度校验
   * （进程名 + 可执行文件路径 + 实际启动时间），而不只是比对进程名。
   */
  public cleanupStaleProcesses(): void {
    if (!this.lockFilePath || !fs.existsSync(this.lockFilePath)) return
    try {
      const content = fs.readFileSync(this.lockFilePath, 'utf-8')
      const records = sanitizeRecords(JSON.parse(content))
      if (records.length > 0) {
        logger.info(
          LogCategory.SYSTEM,
          `[ProcessReaper] 发现上一次异常退出遗留的 ${records.length} 个子进程，正在定向清理...`
        )
        // 一次批量取回全部 PID 的身份，避免 N 条记录触发 N 次 PowerShell 冷启动
        // （本方法在 main/index.ts 模块顶层同步执行，早于单实例锁与窗口创建）
        const identities = this.resolveIdentities(records, 'deep')
        for (const record of records) {
          this.killVerified(record, identities, 'deep')
        }
      }
      // 历史记录已在上面（无论杀掉还是拒绝清理）处理完毕，必须同步清空内存副本。
      // 否则退出时 cleanup() 会用 fast 模式（仅比对进程名）再处理一遍这批记录，
      // 把刚刚因「路径不一致 / 同名不同代」被深度校验拒绝的进程重新杀掉。
      this.pids.clear()
      fs.writeFileSync(this.lockFilePath, '[]', 'utf-8')
    } catch (err: any) {
      // 解析或回写失败意味着历史记录会原样留到下次启动，属于必须可见的现场
      logger.warn(
        LogCategory.SYSTEM,
        `[ProcessReaper] 清理历史遗留记录失败，下次启动将重新校验: ${err?.message || err}`
      )
    }
  }

  /**
   * 批量解析待清理进程的身份。
   * @returns 查询能力不可用时返回 null（调用方据此拒绝盲杀）；否则返回 PID → 身份 的映射
   */
  private resolveIdentities(
    records: PidRecord[],
    mode: 'fast' | 'deep'
  ): Map<number, ProcIdentity> | null {
    const pids = records.map(r => r.pid)

    if (mode === 'deep') {
      return queryProcessIdentities(pids)
    }

    // fast 模式只取「PID → 进程名」，按 PID 定向查询，不做全表枚举
    const names = queryProcessNames(pids)
    if (!names) return null
    const map = new Map<number, ProcIdentity>()
    for (const pid of pids) {
      const name = names.get(pid)
      if (name) map.set(pid, { pid, name, exePath: '', startedAtMs: 0 })
    }
    return map
  }

  /**
   * 校验身份后销毁指定 PID。
   *
   * 校验顺序（任一不通过即拒绝清理）：
   *   1. 身份查询能力是否可用 —— 不可用宁可留孤儿也不盲杀
   *   2. 该 PID 当前是否还有进程 —— 已自行退出则无需处理
   *   3. 当前进程名与登记的可执行文件名是否一致 —— 不一致说明 PID 已被复用
   *   4. 深度模式下：可执行文件路径是否一致 —— 区分「同名不同程序」（如多个 worktree 的同一引擎）
   *   5. 深度模式下：进程实际启动时间是否晚于登记时间 —— 判定「同名不同代」
   *
   * @param record 登记记录
   * @param identities 已批量解析好的身份表；null 表示查询能力不可用
   * @param mode fast=仅进程名（轻量，退出钩子用）；deep=进程名+路径+启动时间（启动阶段用）
   */
  private killVerified(
    record: PidRecord,
    identities: Map<number, ProcIdentity> | null,
    mode: 'fast' | 'deep'
  ): void {
    const { pid, name } = record
    const expectedExeName = deriveExeName(name, record.exeName)

    // 查询能力不可用：拒绝盲杀
    if (!identities) {
      logger.error(
        LogCategory.SYSTEM,
        `[ProcessReaper] ⛔ 进程身份校验能力不可用（${mode}），为避免误杀已跳过清理: ${name} (PID: ${pid})。若确认该进程为孤儿，请手动结束。`
      )
      return
    }

    const info = identities.get(pid)
    if (!info) {
      logger.info(
        LogCategory.SYSTEM,
        `[ProcessReaper] 子进程已自行退出，无需清理: ${name} (PID: ${pid})`
      )
      return
    }

    // 进程名不一致 => PID 已被无关进程复用，拒绝清理
    if (!isNameMatch(expectedExeName, info.name)) {
      logger.warn(
        LogCategory.SYSTEM,
        `[ProcessReaper] ⚠️ PID 身份不匹配，拒绝清理（该 PID 已被其他进程占用）: 记录=${name}(${expectedExeName}) PID=${pid}，当前进程名=${info.name}`
      )
      return
    }

    // 深度模式：路径不一致 => 同名但不同程序（典型：多个 worktree 各跑一份同一引擎），拒绝清理
    if (mode === 'deep' && record.exePath && info.exePath) {
      if (!isPathEqual(record.exePath, info.exePath)) {
        logger.warn(
          LogCategory.SYSTEM,
          `[ProcessReaper] ⚠️ 可执行文件路径不一致，拒绝清理: ${name} (PID: ${pid})，记录=${record.exePath}，当前=${info.exePath}`
        )
        return
      }
    }

    // 同名但启动时间晚于登记时间 => 是「同名不同代」的新进程，拒绝清理。
    // createdAt 缺失（脏记录 / 旧版本遗留）时跳过该判据：没有基准时间就无法比较，
    // 硬比会把 0 当基准、导致任何存活进程都被判成「新进程」而永远不被回收。
    if (
      mode === 'deep' &&
      record.createdAt > 0 &&
      info.startedAtMs > 0 &&
      info.startedAtMs > record.createdAt + PID_REUSE_TOLERANCE_MS
    ) {
      logger.warn(
        LogCategory.SYSTEM,
        `[ProcessReaper] ⚠️ 进程启动时间晚于登记时间，判定为同名新进程，拒绝清理: ${name} (PID: ${pid})，实际启动=${new Date(info.startedAtMs).toISOString()}，登记时间=${new Date(record.createdAt).toISOString()}`
      )
      return
    }

    try {
      if (process.platform === 'win32') {
        const res = spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
          windowsHide: true,
          stdio: 'ignore'
        })
        // taskkill 失败不会抛异常，只能看退出码；权限不足等失败必须留痕
        if (res.status !== 0) {
          logger.warn(
            LogCategory.SYSTEM,
            `[ProcessReaper] taskkill 未能结束进程（可能已退出或无权限）: ${name} (PID: ${pid}), exitCode=${res.status}`
          )
          return
        }
      } else {
        process.kill(pid, 'SIGKILL')
      }
      logger.info(LogCategory.SYSTEM, `[ProcessReaper] ✅ 已销毁遗留子进程: ${name} (PID: ${pid})`)
    } catch (err: any) {
      // ESRCH = 进程已退出（正常），EPERM = 权限不足（需要留痕，否则孤儿永远查不到原因）
      if (err?.code === 'ESRCH') return
      logger.warn(
        LogCategory.SYSTEM,
        `[ProcessReaper] 结束进程失败: ${name} (PID: ${pid}), code=${err?.code ?? 'unknown'}, ${err?.message || err}`
      )
    }
  }

  private persistPids(): void {
    if (!this.lockFilePath) return
    try {
      const records = Array.from(this.pids.values())
      fs.writeFileSync(this.lockFilePath, JSON.stringify(records, null, 2), 'utf-8')
    } catch {}
  }

  private registerExitHooks(): void {
    const onExit = () => {
      this.cleanup()
    }

    process.once('exit', onExit)
    process.once('SIGINT', onExit)
    process.once('SIGTERM', onExit)
    process.once('SIGHUP', onExit)

    app.once('before-quit', onExit)
    app.once('will-quit', onExit)
  }
}

export const processReaper = ProcessReaper.getInstance()
