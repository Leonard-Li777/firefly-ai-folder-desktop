import { describe, expect, it } from 'vitest'
import {
  buildCoverUrl,
  buildExtractRequestBody,
  buildPerceiveRequestBody
} from '../omni-service/request-serialization'

const noopConfig = <T>(_key: string): T | undefined => undefined

describe('Omni 逐请求字段映射契约 (SLICE-05)', () => {
  it('perceive 全字段映射至 Rust snake_case，enableOfficeCover 回退 enableCover', () => {
    const body = buildPerceiveRequestBody(
      '/tmp/a.pdf',
      {
        enableImageOcr: false,
        ocrModelSize: 'small',
        maxDocumentOcrItems: 0,
        extractPages: 2,
        enableOfficeCover: false,
        enableCover: true,
        videoAsrDurationSec: 0,
        enableVideoVisualAnalysis: false,
        enableNsfwPerception: false,
        enableFacePerception: false,
        maxContentSizeKb: -1
      },
      noopConfig
    )

    expect(body).toMatchObject({
      file_path: '/tmp/a.pdf',
      enable_image_ocr: false,
      ocr_model_size: 'small',
      max_document_ocr_items: 0,
      extract_pages: 2,
      enable_office_cover: false,
      video_asr_duration_sec: 0,
      enable_video_visual_analysis: false,
      enable_nsfw_perception: false,
      enable_face_perception: false,
      max_content_size_kb: -1
    })
    // 显式 false 不能被 enableCover=true 覆盖
    expect(body.enable_office_cover).toBe(false)
  })

  it('perceive 未传 enableOfficeCover 时才回退历史别名 enableCover', () => {
    const body = buildPerceiveRequestBody('/tmp/a.docx', { enableCover: true }, noopConfig)
    expect(body.enable_office_cover).toBe(true)
  })

  it('extract 回退通道与 perceive 同源，逐请求参数零丢失', () => {
    const body = buildExtractRequestBody('/tmp/b.pdf', {
      extractPages: 3,
      ocrModelSize: 'tiny',
      enableImageOcr: true,
      maxDocumentOcrItems: -1,
      maxContentSizeKb: -1
    })
    expect(body).toEqual({
      file_path: '/tmp/b.pdf',
      extract_pages: 3,
      enable_image_ocr: true,
      ocr_model_size: 'tiny',
      max_document_ocr_items: -1,
      max_content_size_kb: -1,
      enable_office_cover: undefined
    })
  })

  it('getFileCover 的 enable_office_cover false/true 均显式写入 query', () => {
    expect(buildCoverUrl('http://omni:1234', '/tmp/c.docx', { enableOfficeCover: false })).toContain(
      'enable_office_cover=false'
    )
    expect(buildCoverUrl('http://omni:1234', '/tmp/c.docx', { enableOfficeCover: true })).toContain(
      'enable_office_cover=true'
    )
    expect(buildCoverUrl('http://omni:1234', '/tmp/c.docx', { enableOfficeCover: false })).toContain(
      'path=%2Ftmp%2Fc.docx'
    )
    // 未传时不得写 query，保持与全局 cfg 兜底语义一致
    expect(buildCoverUrl('http://omni:1234', '/tmp/c.docx', {})).not.toContain('enable_office_cover')
  })

  it('perceive 透传 perceive_timeout_sec 且未传时不写入该字段', () => {
    const withTimeout = buildPerceiveRequestBody(
      '/tmp/v.mp4',
      { perceiveTimeoutSec: 240.5 },
      noopConfig
    )
    expect(withTimeout.perceive_timeout_sec).toBe(240.5)

    const withoutTimeout = buildPerceiveRequestBody('/tmp/v.mp4', {}, noopConfig)
    expect('perceive_timeout_sec' in withoutTimeout).toBe(false)
  })
})
