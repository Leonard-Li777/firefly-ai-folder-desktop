import fs from 'node:fs'
import path from 'node:path'
import { MinimumUnitResult } from '@yonuc/types'
import { t } from '@app/languages'

function isImage(ext: string) {
  return ['.jpg','.jpeg','.png','.gif','.webp','.bmp','.tiff','.svg'].includes(ext.toLowerCase())
}
function isVideo(ext: string) {
  return ['.mp4','.mkv','.avi','.mov','.webm'].includes(ext.toLowerCase())
}
function isDoc(ext: string) {
  return ['.pdf','.doc','.docx','.ppt','.pptx','.txt','.md'].includes(ext.toLowerCase())
}

export class MinimumUnitService {
  // 假逻辑：
  // 1) 若目录内存在".minunit"标记文件 => 视为最小单元
  // 2) 若目录下文件总数<=3 => 视为最小单元（小集合）
  // 3) 若目录下文件全为图片或全为视频，且数量<=50 => 视为最小单元（相册/视频集）
  // 4) 若混合类型、数量大或含复杂层级 => expand
  async check(pathInput: string): Promise<MinimumUnitResult> {
    try {
      const stat = fs.statSync(pathInput)
      if (!stat.isDirectory()) {
        return { path: pathInput, isDirectory: false, decision: 'min-unit', reason: t('普通文件') }
      }
      const entries = fs.readdirSync(pathInput, { withFileTypes: true })
      // 标记文件
      if (entries.find(e => e.isFile() && e.name.toLowerCase() === '.minunit')) {
        return { path: pathInput, isDirectory: true, decision: 'min-unit', reason: t('存在标记文件') }
      }
      const files = entries.filter(e => e.isFile())
      const subdirs = entries.filter(e => e.isDirectory())
      if (files.length === 0 && subdirs.length === 0) {
        return { path: pathInput, isDirectory: true, decision: 'min-unit', reason: t('空目录') }
      }
      if (files.length <= 3 && subdirs.length === 0) {
        return { path: pathInput, isDirectory: true, decision: 'min-unit', reason: t('小文件集(<=3)且无子目录') }
      }
      // 统计类型
      let img = 0, vid = 0, doc = 0, other = 0
      for (const f of files) {
        const ext = path.extname(f.name)
        if (isImage(ext)) img++
        else if (isVideo(ext)) vid++
        else if (isDoc(ext)) doc++
        else other++
      }
      const total = files.length
      if (total > 0 && other === 0 && subdirs.length === 0 && total <= 50) {
        if (img === total) return { path: pathInput, isDirectory: true, decision: 'min-unit', reason: t('纯图片相册(<=50)') }
        if (vid === total) return { path: pathInput, isDirectory: true, decision: 'min-unit', reason: t('纯视频集合(<=50)') }
        if (doc === total && total <= 20) return { path: pathInput, isDirectory: true, decision: 'min-unit', reason: t('纯文档集合(<=20)') }
      }
      // 有子目录或类型混杂 => expand
      return { path: pathInput, isDirectory: true, decision: 'expand', reason: t('包含子目录或类型混合') }
    } catch (e) {
      return { path: pathInput, isDirectory: false, decision: 'min-unit', reason: t('检查失败，按文件处理') }
    }
  }
}

export const minimumUnitService = new MinimumUnitService()

