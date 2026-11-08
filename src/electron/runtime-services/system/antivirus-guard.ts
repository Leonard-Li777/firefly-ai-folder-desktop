/**
 * 杀毒软件防御拦截看护 (Antivirus Security Guard)
 * apps/desktop/src/electron/runtime-services/system/antivirus-guard.ts
 *
 * 核心职责 (Ticket 05 / Spec §5.1):
 * 捕获 Windows Defender / 火绒等杀软偶发拦截进程拉起触发的 EPERM / EACCES 异常，
 * 弹出温和的系统引导对话框，提供一键复制可执行文件路径与加白指令，绝不静默闪退。
 */

import { dialog, clipboard, BrowserWindow } from 'electron'
import { logger, LogCategory } from '@firefly/shared'

export function isSecurityBlockError(err: any): boolean {
  const code = err?.code || (typeof err === 'string' && err) || ''
  const message = err?.message || String(err)
  return (
    code === 'EPERM' ||
    code === 'EACCES' ||
    message.includes('EPERM') ||
    message.includes('EACCES') ||
    message.includes('operation not permitted') ||
    message.includes('permission denied')
  )
}

export function handleExecutableSecurityBlock(exePath: string, err: any): boolean {
  if (!isSecurityBlockError(err)) {
    return false
  }

  logger.error(
    LogCategory.SYSTEM,
    `[SecurityGuard] 核心执行器被安全软件拦截: ${exePath}, err: ${err?.message || err}`
  )

  try {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
    const detail = `系统检测到执行器调用被 Windows Defender 或第三方安全软件拦截。\n可执行文件: ${exePath}\n\n建议将应用安装目录或该文件添加至杀毒软件信任区/排除项。`
    dialog
      ?.showMessageBox(win, {
        type: 'warning',
        title: '核心执行器防护提示',
        message: '可执行组件启动被安全软件拦截',
        detail,
        buttons: ['复制文件路径', '确定'],
        defaultId: 0
      })
      ?.then(res => {
        if (res.response === 0) {
          clipboard?.writeText(exePath)
        }
      })
      ?.catch(() => {})
  } catch {}

  return true
}
