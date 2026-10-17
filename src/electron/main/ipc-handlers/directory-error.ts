import { t } from '@app/languages'

/**
 * 生成读取目录失败的友好错误提示文案
 * 支持注入 platform 以供跨平台单元测试断言
 */
export function getDirectoryAccessErrorMessage(
  dirPath: string,
  errorCode?: string,
  errorDetail?: string,
  platform = process.platform
): string {
  if (errorCode === 'EPERM' || errorCode === 'EACCES') {
    if (platform === 'darwin') {
      return t(
        '权限不足，请前往 macOS「系统设置 -> 隐私与安全性 -> 文件和文件夹」授予本应用访问该目录的权限: {dirPath}',
        { dirPath }
      )
    }
    return t('权限不足，无法访问目录: {dirPath}', { dirPath })
  }
  if (errorCode === 'ENOENT') {
    return t('目录不存在: {dirPath}', { dirPath })
  }
  return t('无法读取目录: {dirPath} ({errorDetail})', {
    dirPath,
    errorDetail: errorCode || errorDetail || ''
  })
}
