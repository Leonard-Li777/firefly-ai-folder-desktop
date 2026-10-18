import { t } from '@app/languages'

/**
 * macOS 隐私与权限说明（TCC 权限保护：Downloads / Desktop / Documents 等）
 * 打包时由 @electron/packager 合并至 App Bundle 的 Info.plist 中
 *
 * 国际化规范约束：
 * 1. 面向用户的展示文案统一使用 t(静态string) 函数包裹；
 * 2. 避免静态对象失效，必须通过函数动态返回对象，确保语言切换时动态刷新；
 * 3. 严禁使用硬编码双语三元分支（如 buildRegion === 'cn' ? 中文 : 英文）绕过统一 i18n 体系。
 */
export function getMacExtendInfo(): Record<string, string> {
  return {
    NSDownloadsFolderUsageDescription: t('萤核智能文件夹需要访问您的“下载”文件夹以整理和检索文件。'),
    NSDesktopFolderUsageDescription: t('萤核智能文件夹需要访问您的“桌面”文件夹以整理和检索文件。'),
    NSDocumentsFolderUsageDescription: t('萤核智能文件夹需要访问您的“文稿”文件夹以整理和检索文件。'),
    NSRemovableVolumesUsageDescription: t('萤核智能文件夹需要访问外接存储设备以整理和检索文件。'),
    NSNetworkVolumesUsageDescription: t('萤核智能文件夹需要访问网络共享卷以整理和检索文件。')
  }
}

/**
 * 打包期默认回退配置对象（供 forge.config.ts 构建时消费）
 * 注意：运行时业务逻辑请统一调用 getMacExtendInfo() 动态获取，防止静态对象在语言切换后失效
 */
export const MAC_EXTEND_INFO = getMacExtendInfo()

