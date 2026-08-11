import { describe, it, expect, vi } from 'vitest'
import { getPreviewRouteType } from './preview-utils'
import { FileCategory } from '@firefly/shared'

// Mock getFileCategory since it depends on shared logic
vi.mock('@firefly/shared', async () => {
  const actual = await vi.importActual<any>('@firefly/shared')
  return {
    ...actual,
    getFileCategory: (filename: string) => {
      const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase()
      if (['.jpg', '.png', '.webp'].includes(ext)) return actual.FileCategory.IMAGE
      if (['.mp4', '.mkv'].includes(ext)) return actual.FileCategory.VIDEO
      if (['.mp3', '.wav'].includes(ext)) return actual.FileCategory.AUDIO
      if (['.txt', '.md'].includes(ext)) return actual.FileCategory.TEXT
      if (['.doc', '.docx', '.xls', '.xlsx'].includes(ext)) return actual.FileCategory.OFFICE
      if (['.ts', '.js', '.py'].includes(ext)) return actual.FileCategory.CODE
      return actual.FileCategory.UNKNOWN
    }
  }
})

describe('preview-utils', () => {
  describe('getPreviewRouteType', () => {
    it('should return native for images, videos, audio, and text', () => {
      expect(getPreviewRouteType('jpg')).toBe('native')
      expect(getPreviewRouteType('.jpg')).toBe('native')
      expect(getPreviewRouteType('mp4')).toBe('native')
      expect(getPreviewRouteType('mp3')).toBe('native')
      expect(getPreviewRouteType('txt')).toBe('native')
    })

    it('should return flyfish for office, pdf, cad, 3d, and source files', () => {
      expect(getPreviewRouteType('docx')).toBe('flyfish')
      expect(getPreviewRouteType('pdf')).toBe('flyfish')
      expect(getPreviewRouteType('dwg')).toBe('flyfish')
      expect(getPreviewRouteType('stl')).toBe('flyfish')
      expect(getPreviewRouteType('ts')).toBe('flyfish')
    })

    it('should return unsupported for unknown formats', () => {
      expect(getPreviewRouteType('xyz123')).toBe('unsupported')
      expect(getPreviewRouteType('abc')).toBe('unsupported')
    })
  })
})
