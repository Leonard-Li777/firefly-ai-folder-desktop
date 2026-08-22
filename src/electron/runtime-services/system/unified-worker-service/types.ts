/**
 * 统一常驻微服务 (Unified Worker Service) 类型定义
 */

export interface WorkerHealthStatus {
  status: 'ok' | 'degraded' | 'error'
  uptime: number
  memoryUsage: NodeJS.MemoryUsage
  activeServices: {
    ocr: boolean
    magika: boolean
    exiftool: boolean
    libreoffice: boolean
    ffmpeg: boolean
  }
}

export interface OCRRequestOptions {
  modelType?: 'tiny' | 'small' | 'medium'
  languages?: string[]
}

export interface OCRResult {
  text: string
  confidence?: number
  blocks?: Array<{
    text: string
    box?: number[][]
    score?: number
  }>
  durationMs: number
}

export interface MagikaIdentifyResult {
  label: string
  group: string
  description: string
  extensions: string[]
  is_text: boolean
  mime_type: string
  score: number
}

export interface DocumentPreviewOptions {
  pageNumber?: number
  maxWidth?: number
  maxHeight?: number
  quality?: number
  effectiveExt?: string
}

export interface DocumentPreviewResult {
  coverPath: string
  pdfPath?: string
  pageCount?: number
  durationMs: number
}

export interface MediaThumbnailOptions {
  seekTimeSeconds?: number
  width?: number
  height?: number
  quality?: number
}

export interface MediaInfoResult {
  durationSeconds: number
  format: string
  width?: number
  height?: number
  audioChannels?: number
  bitrate?: number
}
