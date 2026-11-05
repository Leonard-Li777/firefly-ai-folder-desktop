/**
 * 文件预览引擎核心类型与契约定义
 * 遵循规格书 docs/specs/file-previewer-engine-and-custom-extensions-spec.md (v1.2)
 */

export type PreviewRouteType = 'native' | 'flyfish' | 'unsupported'

export type PreviewCandidateKind = 'builtin_react' | 'external_iframe' | 'flyfish' | 'system_icon'

export interface PreviewCandidate {
  readonly id: string
  readonly name: string
  readonly kind: PreviewCandidateKind
  readonly supportedExtensions: string[]
  readonly declaredPriority: number
  readonly effectivePriority: number
  readonly isOfficialCertified?: boolean
  readonly isTrustedForPrivate?: boolean
  readonly entryHtmlUrl?: string
}

export interface PreviewContext {
  readonly filePath: string
  readonly fileName: string
  readonly extension: string
  readonly fileSize: number
  readonly fileFingerprint: string
  readonly requestId: string
  readonly generation: number
  readonly signal: AbortSignal
  /** 隐私工作区标记 */
  readonly isPrivate: boolean
  readonly workspaceDirectoryType?: 'SPEEDY' | 'PRIVATE' | 'VDIR'
  /** 媒体增强参数 */
  readonly multimodalContent?: string | null
  readonly currentTime?: number
  readonly highlightRange?: [number, number]
}

export interface PreviewSession {
  readonly sessionId: string
  readonly requestId: string
  readonly generation: number
  readonly filePath: string
  readonly abortController: AbortController
  cursor: number
  candidates: PreviewCandidate[]
}

export type PreviewMessageType =
  | 'PREVIEW_INIT' // 宿主 -> Iframe: 握手建立，传递 channelSecret
  | 'PREVIEW_BOOTED' // Iframe -> 宿主: 容器就绪，报告环境就绪
  | 'PREVIEW_LOAD' // 宿主 -> Iframe: 传递文件元数据与会话流 URL
  | 'PREVIEW_PROGRESS' // Iframe -> 宿主: 报告解析进度心跳 (防止被判定超时)
  | 'PREVIEW_READY' // Iframe -> 宿主: 首屏渲染成功完成
  | 'PREVIEW_ERROR' // Iframe -> 宿主: 捕获致命错误，附带结构化错误码
  | 'PREVIEW_DISPOSE' // 宿主 -> Iframe: 请求主动销毁资源、释放 WebGL
  | 'PREVIEW_RESIZE' // 宿主 -> Iframe: 容器尺寸变化通知
  | 'PREVIEW_THEME' // 宿主 -> Iframe: 主题联动

export interface PreviewMessageEnvelope<T = any> {
  readonly sessionId: string
  readonly requestId: string
  readonly generation: number
  readonly channelSecret: string
  readonly type: PreviewMessageType
  readonly payload?: T
}

export const PREVIEW_ERROR_CODES = {
  ERR_PARSE_CORRUPTED: 'ERR_PARSE_CORRUPTED',
  ERR_UNSUPPORTED_VERSION: 'ERR_UNSUPPORTED_VERSION',
  ERR_OOM_RESOURCE_EXHAUSTED: 'ERR_OOM_RESOURCE_EXHAUSTED',
  ERR_TIMEOUT_NO_HEARTBEAT: 'ERR_TIMEOUT_NO_HEARTBEAT'
} as const

export type PreviewErrorCode = keyof typeof PREVIEW_ERROR_CODES

/**
 * 复合元数据指纹计算函数：避免全量哈希阻塞 I/O
 */
export function getFileFingerprint(
  filePath: string,
  size: number = 0,
  mtimeMs: number = 0
): string {
  return `${filePath}:${size}:${mtimeMs}`
}
