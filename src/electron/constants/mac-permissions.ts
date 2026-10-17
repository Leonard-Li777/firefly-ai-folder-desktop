/**
 * macOS 隐私与权限说明（TCC 权限保护：Downloads / Desktop / Documents 等）
 * 打包时由 @electron/packager 合并至 App Bundle 的 Info.plist 中
 */
export function getMacExtendInfo(buildRegion: 'cn' | 'intl') {
  return {
    NSDownloadsFolderUsageDescription:
      buildRegion === 'cn'
        ? '萤核智能文件夹需要访问您的“下载”文件夹以整理和检索文件。'
        : 'Firefly AI Folder needs access to your Downloads folder to organize and search files.',
    NSDesktopFolderUsageDescription:
      buildRegion === 'cn'
        ? '萤核智能文件夹需要访问您的“桌面”文件夹以整理和检索文件。'
        : 'Firefly AI Folder needs access to your Desktop folder to organize and search files.',
    NSDocumentsFolderUsageDescription:
      buildRegion === 'cn'
        ? '萤核智能文件夹需要访问您的“文稿”文件夹以整理和检索文件。'
        : 'Firefly AI Folder needs access to your Documents folder to organize and search files.',
    NSRemovableVolumesUsageDescription:
      buildRegion === 'cn'
        ? '萤核智能文件夹需要访问外接存储设备以整理和检索文件。'
        : 'Firefly AI Folder needs access to removable volumes to organize and search files.',
    NSNetworkVolumesUsageDescription:
      buildRegion === 'cn'
        ? '萤核智能文件夹需要访问网络共享卷以整理和检索文件。'
        : 'Firefly AI Folder needs access to network volumes to organize and search files.'
  }
}

export const MAC_EXTEND_INFO = getMacExtendInfo(
  (process.env.BUILD_REGION || 'CN').trim().toLowerCase() === 'cn' ? 'cn' : 'intl'
)
