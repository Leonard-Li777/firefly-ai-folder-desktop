/**
 * Worktree 运行环境自举（Bootstrap）
 *
 * 【硬约束】必须在 `main/index.ts` 中作为**第一条 import** 引入。
 *
 * 背景（为什么需要单独一个模块）：
 * ES Module 的 import 声明会**先于入口文件正文**、按源码顺序求值。而
 * `logging-service`（构造期经 platformAdapter 读取 userData）与
 * `system-health-service`（构造期经 ConfigOrchestrator 读取 userData）等模块
 * 在「模块求值阶段」就会调用 `app.getPath('userData')` 并把结果固化到实例字段上。
 *
 * 若这些模块早于 `initWorktreeEnvironment()` 求值，userData 仍是 Electron 默认目录
 * （`%APPDATA%/firefly-ai-folder`，由 package.json 的 productName 推导，**不带**
 * `_v4_{region}_{env}_{worktree}` 隔离后缀），于是出现「配置/日志写共享裸目录、
 * 业务主库写 per-worktree 目录」的双目录分裂：
 * 执行 `pnpm clear:user-data` 只清理了 per-worktree 目录，`LANGUAGE_CONFIRMED`
 * 仍在共享目录中残留为 true，再次启动便不再进入欢迎向导的语言选择页。
 *
 * 因此把 userData 隔离提前到「任何捕获点之前」执行，使配置、日志、模型目录等
 * 全部收敛到当前实例的 userData 目录，与 worktree-env.ts 的隔离设计保持一致。
 */
import { initWorktreeEnvironment } from './worktree-env'

export const worktreeInfo = initWorktreeEnvironment()
