/**
 * 工作区工作流智能推荐器单测套件 (Spec v1.1 §3.2 & Ticket 02)
 *
 * 核心验证目标：
 * 1. AC-2.1: 纯函数 (@pure) 属性，无副作用，直接消费 BLUEPRINT_STATIC_TEMPLATES；
 * 2. AC-2.2: 离线黄金画像测试 (用例 A ~ 用例 G) 100% 通过；
 * 3. AC-2.3: 空目录 totalFiles === 0 零值防 NaN 崩溃与单一 FALLBACK 校验；
 * 4. AC-2.4: 确定性平局裁决与连续 100 次运行顺序稳定性；
 * 5. AC-2.5: 桌面 vs 下载互斥铁律 (用例 A 绝对不推荐下载流)；
 * 6. 超高熵平局降级守卫与路径先验加权验证。
 */

import { describe, it, expect } from 'vitest'
import {
  recommendWorkflowByProfile,
  DirectoryProfileStats
} from '../workflow-preset-and-recommender'
import {
  BLUEPRINT_STATIC_TEMPLATES,
  BlueprintStaticTemplate
} from '../../../config/organize-taxonomy-source'

// 导入离线黄金画像 JSON 夹具
import useCaseA from './fixtures/directory-profiles/use-case-a-desktop-mixed.json'
import useCaseB from './fixtures/directory-profiles/use-case-b-downloads-installers.json'
import useCaseC from './fixtures/directory-profiles/use-case-c-3d-modeling.json'
import useCaseD from './fixtures/directory-profiles/use-case-d-plain-images.json'
import useCaseE from './fixtures/directory-profiles/use-case-e-tie-break.json'
import useCaseF from './fixtures/directory-profiles/use-case-f-insufficient-samples.json'
import useCaseG from './fixtures/directory-profiles/use-case-g-empty-directory.json'

describe('Workflow Preset & Recommender Engine (Spec v1.1 §3.2)', () => {
  describe('AC-2.1: 纯函数约束与事实源直读', () => {
    it('应在不传入 templates 参数时默认直读 BLUEPRINT_STATIC_TEMPLATES 并稳定返回结果', () => {
      const stats: DirectoryProfileStats = Object.freeze({
        totalFiles: 20,
        countsByExt: Object.freeze({
          '.blend': 5,
          '.png': 15
        })
      })

      const results = recommendWorkflowByProfile(stats)
      expect(results).toBeDefined()
      expect(Array.isArray(results)).toBe(true)
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].tier).toBe('T1')
      expect(results[0].isTopRecommendation).toBe(true)
    })

    it('入参对象为深度冻结 (Object.freeze) 时，执行过程绝无就地修改', () => {
      const frozenStats: DirectoryProfileStats = Object.freeze({
        totalFiles: 10,
        countsByExt: Object.freeze({
          '.docx': 8,
          '.xlsx': 2
        }),
        isDesktopPath: false,
        isDownloadsPath: false
      })

      expect(() => {
        const results = recommendWorkflowByProfile(frozenStats)
        expect(results[0].tier).toBe('T3')
      }).not.toThrow()
    })

    it('不依赖时钟与随机数，针对相同输入连续调用返回完全一致的纯计算结果', () => {
      const stats: DirectoryProfileStats = {
        totalFiles: 15,
        countsByExt: { '.cr3': 4, '.jpg': 11 }
      }

      const res1 = recommendWorkflowByProfile(stats)
      const res2 = recommendWorkflowByProfile(stats)

      expect(res1).toEqual(res2)
    })
  })

  describe('AC-2.2: 离线黄金画像用例集验证', () => {
    it('用例 A: 桌面混合散杂文件画像 ➔ 100% 首推桌面急救清理，且绝对不推荐下载流', () => {
      const stats: DirectoryProfileStats = useCaseA.profile
      const results = recommendWorkflowByProfile(stats)

      expect(results.length).toBeGreaterThan(0)
      const top = results[0]
      expect(top.workflowId).toBe(useCaseA.expected.topWorkflowId)
      expect(top.tier).toBe(useCaseA.expected.tier)
      expect(top.score).toBeGreaterThanOrEqual(useCaseA.expected.minScore)
      expect(top.isTopRecommendation).toBe(true)

      // AC-2.5 互斥守卫：桌面散杂且快捷方式 >= 2 时，绝不允许推荐下载流
      const recIds = results.map(r => r.workflowId)
      for (const forbidden of useCaseA.expected.forbiddenWorkflowIds) {
        expect(recIds).not.toContain(forbidden)
      }
    })

    it('用例 B: 网络下载目录文件画像 ➔ 100% 首推下载分流，绝不误判为桌面急救', () => {
      const stats: DirectoryProfileStats = useCaseB.profile
      const results = recommendWorkflowByProfile(stats)

      expect(results.length).toBeGreaterThan(0)
      const top = results[0]
      expect(top.workflowId).toBe(useCaseB.expected.topWorkflowId)
      expect(top.tier).toBe(useCaseB.expected.tier)
      expect(top.score).toBeGreaterThanOrEqual(useCaseB.expected.minScore)

      const recIds = results.map(r => r.workflowId)
      for (const forbidden of useCaseB.expected.forbiddenWorkflowIds) {
        expect(recIds).not.toContain(forbidden)
      }
    })

    it('用例 C: 3D 资产建模工程画像 ➔ 100% 首推 3D 资产，T1 梯队 >= 95分', () => {
      const stats: DirectoryProfileStats = useCaseC.profile
      const results = recommendWorkflowByProfile(stats)

      expect(results.length).toBeGreaterThan(0)
      const top = results[0]
      const validIds = [
        useCaseC.expected.topWorkflowId,
        ...(useCaseC.expected.alternativeTopIds || [])
      ]
      expect(validIds).toContain(top.workflowId)
      expect(top.tier).toBe(useCaseC.expected.tier)
      expect(top.score).toBeGreaterThanOrEqual(useCaseC.expected.minScore)
      expect(top.reasonCode).toBe(useCaseC.expected.reasonCode)
    })

    it('用例 D: 普通图片相册画像 ➔ 绝不错误推荐专业设计与前端开发流', () => {
      const stats: DirectoryProfileStats = useCaseD.profile
      const results = recommendWorkflowByProfile(stats)

      const recIds = results.map(r => r.workflowId)
      for (const forbidden of useCaseD.expected.forbiddenWorkflowIds) {
        expect(recIds).not.toContain(forbidden)
      }
    })

    it('用例 F: 小样本目录画像 (totalFiles < 5) ➔ 100% 回退至 FALLBACK 并标记 insufficient_samples', () => {
      const stats: DirectoryProfileStats = useCaseF.profile
      const results = recommendWorkflowByProfile(stats)

      expect(results.length).toBe(1)
      const top = results[0]
      const validIds = [
        useCaseF.expected.topWorkflowId,
        ...(useCaseF.expected.alternativeTopIds || [])
      ]
      expect(validIds).toContain(top.workflowId)
      expect(top.tier).toBe(useCaseF.expected.tier)
      expect(top.score).toBe(useCaseF.expected.score)
      expect(top.reasonCode).toBe(useCaseF.expected.reasonCode)
    })

    it('用例 G: 空目录零值边界防御画像 ➔ 100% 返回单一 FALLBACK，零 NaN 产生', () => {
      const stats: DirectoryProfileStats = useCaseG.profile
      const results = recommendWorkflowByProfile(stats)

      expect(results.length).toBe(1)
      const top = results[0]
      const validIds = [
        useCaseG.expected.topWorkflowId,
        ...(useCaseG.expected.alternativeTopIds || [])
      ]
      expect(validIds).toContain(top.workflowId)
      expect(top.tier).toBe('FALLBACK')
      expect(top.score).toBe(60)
      expect(top.reasonCode).toBe('empty_directory')

      // 断言零 NaN 污染
      expect(Number.isNaN(top.score)).toBe(false)
      expect(Number.isFinite(top.score)).toBe(true)
    })
  })

  describe('AC-2.3: 空目录防除以零与防 NaN 深度校验', () => {
    it('当 stats 为 null 或 undefined 时应短路返回有效 empty_directory 结果', () => {
      // @ts-expect-error 测试防御边界
      const r1 = recommendWorkflowByProfile(null)
      expect(r1[0].reasonCode).toBe('empty_directory')
      expect(r1[0].score).toBe(60)

      // @ts-expect-error 测试防御边界
      const r2 = recommendWorkflowByProfile(undefined)
      expect(r2[0].reasonCode).toBe('empty_directory')
      expect(r2[0].score).toBe(60)
    })

    it('当 totalFiles 为 0、负数或 NaN 时，严禁抛错且所有数值字段均为有限整数', () => {
      const edgeCases: DirectoryProfileStats[] = [
        { totalFiles: 0, countsByExt: {} },
        { totalFiles: -5, countsByExt: {} },
        { totalFiles: NaN, countsByExt: {} }
      ]

      for (const edge of edgeCases) {
        const results = recommendWorkflowByProfile(edge)
        expect(results.length).toBe(1)
        expect(results[0].tier).toBe('FALLBACK')
        expect(results[0].score).toBe(60)
        expect(Number.isNaN(results[0].score)).toBe(false)
        expect(results[0].reasonCode).toBe('empty_directory')
      }
    })
  })

  describe('AC-2.4: 确定性平局裁决与跨运行排序稳定性', () => {
    it('用例 E: 构造同梯队同分画像，连续 100 次运行返回顺序 100% 一致且按 workflowId 字典序升序', () => {
      const stats: DirectoryProfileStats = useCaseE.profile

      // 运行第 1 次取得基线
      const baseline = recommendWorkflowByProfile(stats)
      expect(baseline.length).toBeGreaterThanOrEqual(2)
      expect(baseline[0].tier).toBe('T1')
      expect(baseline[1].tier).toBe('T1')
      expect(baseline[0].score).toBe(baseline[1].score)

      // 断言第 1 位比第 2 位的 workflowId 字典序更小 (升序)
      expect(baseline[0].workflowId.localeCompare(baseline[1].workflowId)).toBeLessThan(0)

      // 连续运行 100 次，严禁发生任何颠倒或扰动
      for (let i = 0; i < 100; i++) {
        const current = recommendWorkflowByProfile(stats)
        expect(current).toEqual(baseline)
      }
    })
  })

  describe('四阶决策表垂直场景深度断言', () => {
    it('RAW 相机底片：命中 >= 2 且比率 >= 5% 时锁定 T1 摄影原片工作流 (95 ~ 99分)', () => {
      const stats: DirectoryProfileStats = {
        totalFiles: 20,
        countsByExt: {
          '.cr3': 4,
          '.arw': 2,
          '.jpg': 14
        }
      }

      const results = recommendWorkflowByProfile(stats)
      expect(results[0].workflowId).toBe('builtin.workflow.photography-raw')
      expect(results[0].tier).toBe('T1')
      expect(results[0].score).toBeGreaterThanOrEqual(95)
      expect(results[0].score).toBeLessThanOrEqual(99)
      expect(results[0].reasonCode).toBe('photography_raw')
      expect(results[0].evidence?.matchedCount).toBe(6)
    })

    it('无损音频：命中 >= 2 且比率 >= 5% 时推荐无损音乐音频 (92 ~ 98分)', () => {
      const stats: DirectoryProfileStats = {
        totalFiles: 10,
        countsByExt: {
          '.flac': 3,
          '.dsf': 1,
          '.mp3': 6
        }
      }

      const results = recommendWorkflowByProfile(stats)
      const top = results[0]
      expect(['builtin.workflow.lossless-audio', 'builtin.workflow.music-audio']).toContain(
        top.workflowId
      )
      expect(top.tier).toBe('T1')
      expect(top.score).toBeGreaterThanOrEqual(92)
      expect(top.reasonCode).toBe('lossless_audio')
    })

    it('影视后期制作：命中 >= 1 个剪辑工程即触发 T1 (92 ~ 98分)', () => {
      const stats: DirectoryProfileStats = {
        totalFiles: 15,
        countsByExt: {
          '.prproj': 1,
          '.mp4': 14
        }
      }

      const results = recommendWorkflowByProfile(stats)
      const top = results[0]
      expect([
        'builtin.workflow.video-post',
        'builtin.workflow.video-production',
        'builtin.workflow.newmedia-content'
      ]).toContain(top.workflowId)
      expect(top.tier).toBe('T1')
      expect(top.score).toBeGreaterThanOrEqual(92)
      expect(top.reasonCode).toBe('video_post')
    })

    it('二次元漫画：专用漫画包 .cbz/.cbr 命中 >= 2 时触发 T1 专精推荐 (>= 94分)，普通 .zip 绝不触发', () => {
      // 普通 zip 压缩包
      const zipStats: DirectoryProfileStats = {
        totalFiles: 10,
        countsByExt: { '.zip': 4, '.txt': 6 }
      }
      const zipResults = recommendWorkflowByProfile(zipStats)
      const zipRecIds = zipResults.map(r => r.workflowId)
      expect(zipRecIds).not.toContain('builtin.workflow.comic-manga')
      expect(zipRecIds).not.toContain('builtin.workflow.anime-comic')

      // 专业 .cbz 漫画包
      const comicStats: DirectoryProfileStats = {
        totalFiles: 10,
        countsByExt: { '.cbz': 3, '.jpg': 7 }
      }
      const comicResults = recommendWorkflowByProfile(comicStats)
      const top = comicResults[0]
      expect(['builtin.workflow.comic-manga', 'builtin.workflow.anime-comic']).toContain(
        top.workflowId
      )
      expect(top.tier).toBe('T1')
      expect(top.score).toBeGreaterThanOrEqual(94)
      expect(top.reasonCode).toBe('comic_manga')
    })

    it('办公与财务分流：办公文档密集时，表格类 >= 50% 首推财务，否则首推日常办公', () => {
      // 文本与 PPT 为主 ➔ 日常办公
      const dailyStats: DirectoryProfileStats = {
        totalFiles: 10,
        countsByExt: {
          '.docx': 4,
          '.pptx': 2,
          '.xlsx': 1,
          '.png': 3
        }
      }
      const dailyRes = recommendWorkflowByProfile(dailyStats)
      expect([
        'builtin.workflow.office-daily',
        'builtin.workflow.office-docs',
        'builtin.workflow.docs-office-vault'
      ]).toContain(dailyRes[0].workflowId)
      expect(dailyRes[0].reasonCode).toBe('office_daily')

      // 表格类为主 ➔ 财务法务
      const financeStats: DirectoryProfileStats = {
        totalFiles: 10,
        countsByExt: {
          '.xlsx': 4,
          '.csv': 2,
          '.docx': 1,
          '.png': 3
        }
      }
      const financeRes = recommendWorkflowByProfile(financeStats)
      expect(['builtin.workflow.office-finance', 'builtin.workflow.finance-contract']).toContain(
        financeRes[0].workflowId
      )
      expect(financeRes[0].reasonCode).toBe('office_finance')
    })

    it('超高熵平局降级守卫：同时命中 >= 3 个 T1 且最大 T1 比例 < 15% 时降级至 general-inbox', () => {
      const highEntropyStats: DirectoryProfileStats = {
        totalFiles: 100,
        countsByExt: {
          '.cr3': 6, // 6% -> T1
          '.blend': 6, // 6% -> T1
          '.sketch': 6, // 6% -> T1
          '.flac': 6, // 6% -> T1
          '.txt': 76 // 其余杂散
        }
      }

      const results = recommendWorkflowByProfile(highEntropyStats)
      expect(results.length).toBe(1)
      const top = results[0]
      expect([
        'builtin.workflow.general-inbox',
        'builtin.workflow.inbox-staging-universal'
      ]).toContain(top.workflowId)
      expect(top.tier).toBe('FALLBACK')
      expect(top.score).toBe(60)
      expect(top.reasonCode).toBe('high_entropy')
    })

    it('路径先验加权：isDesktopPath 与 isDownloadsPath 分别增加 10 分先验分 (最高 99)', () => {
      // 桌面测试
      const desktopStatsWithoutPrior: DirectoryProfileStats = {
        totalFiles: 20,
        countsByExt: { '.lnk': 3, '.png': 17 },
        isDesktopPath: false
      }
      const baseScore = recommendWorkflowByProfile(desktopStatsWithoutPrior)[0].score

      const desktopStatsWithPrior: DirectoryProfileStats = {
        ...desktopStatsWithoutPrior,
        isDesktopPath: true
      }
      const priorScore = recommendWorkflowByProfile(desktopStatsWithPrior)[0].score

      expect(priorScore).toBe(Math.min(99, baseScore + 10))
    })

    it('代码工程目录应首推代码资产工作流，绝不误推日常办公文档；普通相册与普通视频应精确匹配', () => {
      const codeStats: DirectoryProfileStats = {
        totalFiles: 50,
        docCount: 48,
        countsByExt: { '.ts': 22, '.tsx': 12, '.json': 10, '.py': 4, '.png': 2 }
      }
      const codeRec = recommendWorkflowByProfile(codeStats)
      expect([
        'builtin.workflow.code-asset-vault',
        'builtin.workflow.frontend-dev',
        'builtin.workflow.backend-arch'
      ]).toContain(codeRec[0].workflowId)

      const imgStats: DirectoryProfileStats = {
        totalFiles: 30,
        countsByExt: { '.png': 18, '.jpg': 10, '.mp4': 2 }
      }
      const imgRec = recommendWorkflowByProfile(imgStats)
      expect([
        'builtin.workflow.screenshots-screenrecord-vault',
        'builtin.workflow.media-collector-vault',
        'builtin.workflow.family-household'
      ]).toContain(imgRec[0].workflowId)

      const videoStats: DirectoryProfileStats = {
        totalFiles: 20,
        countsByExt: { '.mp4': 12, '.mkv': 6, '.srt': 2 }
      }
      const videoRec = recommendWorkflowByProfile(videoStats)
      expect(['builtin.workflow.movie-cinema', 'builtin.workflow.media-collector-vault']).toContain(
        videoRec[0].workflowId
      )
    })

    it('支配占比保护：100个安装包目录中夹杂1个.prproj或少数.psd，不得劫持下载分流首推', () => {
      const mixedDownloads: DirectoryProfileStats = {
        totalFiles: 100,
        countsByExt: { '.exe': 45, '.msi': 15, '.zip': 20, '.prproj': 1, '.psd': 6, '.pdf': 13 },
        isDownloadsPath: true
      }
      const res = recommendWorkflowByProfile(mixedDownloads)
      expect(res[0].workflowId).toBe('builtin.workflow.downloads-triage')
    })

    it('Spec §4.1.1 用例 1: 96% 图片目录断言截图录屏稳居榜首且与第二名拉开 >= 15 分', () => {
      const stats: DirectoryProfileStats = {
        totalFiles: 100,
        countsByExt: {
          '.png': 48,
          '.jpg': 48,
          '.pdf': 2,
          '.docx': 1,
          '.lnk': 1
        },
        isDesktopPath: true
      }
      const results = recommendWorkflowByProfile(stats, BLUEPRINT_STATIC_TEMPLATES)
      expect(results.length).toBeGreaterThanOrEqual(2)

      const top1 = results[0]
      const top2 = results[1]

      // 1. 首推必须是 screenshots-screenrecord-vault
      expect(top1.workflowId).toBe('builtin.workflow.screenshots-screenrecord-vault')
      expect(top1.score).toBeGreaterThanOrEqual(85)
      expect(top1.isTopRecommendation).toBe(true)

      // 2. 弱垂类 senior-medical-care-pipeline 必须 <= 70
      const medicalRec = results.find(
        r => r.workflowId === 'builtin.workflow.senior-medical-care-pipeline'
      )
      if (medicalRec) {
        expect(medicalRec.score).toBeLessThanOrEqual(70)
      }

      // 3. 全量第二名 s2 必须 <= 70，分差严格 >= 15
      expect(top2.score).toBeLessThanOrEqual(70)
      expect(top1.score - top2.score).toBeGreaterThanOrEqual(15)
    })

    it('桌面相关工作流契约：desktop-declutter 与 desktop-classic-classification 必须包含 .lnk/.url 扩展名，且绝不置于排除名单中', () => {
      const desktopWorkflows = [
        'builtin.workflow.desktop-declutter',
        'builtin.workflow.desktop-classic-classification'
      ]

      for (const wfId of desktopWorkflows) {
        const bp = BLUEPRINT_STATIC_TEMPLATES.find(t => t.workflow_id === wfId)
        expect(bp).toBeDefined()
        const commonExts = bp?.extensions?.common || []
        const ignores = bp?.custom_ignores || []
        const weights = bp?.extensions?.weights || {}

        // 必须包含常见桌面快捷方式扩展名
        expect(commonExts).toContain('.lnk')
        expect(commonExts).toContain('.url')

        // 严禁将 .lnk 与 .url 放在排除名单中
        expect(ignores).not.toContain('.lnk')
        expect(ignores).not.toContain('.url')

        // 权重字典必须分配正权重
        expect(weights['.lnk']).toBeGreaterThan(0)
        expect(weights['.url']).toBeGreaterThan(0)
      }

      // 在含有丰富快捷方式与办公文档的典型电脑桌面场景下，桌面急救或经典分类应获得高分首推
      const desktopStats: DirectoryProfileStats = {
        totalFiles: 80,
        totalSampled: 80,
        docCount: 20,
        imageCount: 15,
        videoCount: 0,
        otherCount: 45,
        countsByExt: {
          '.lnk': 25,
          '.url': 5,
          '.docx': 10,
          '.xlsx': 10,
          '.png': 15,
          '.exe': 10,
          '.zip': 5
        },
        topExtensions: [
          { ext: '.lnk', count: 25 },
          { ext: '.png', count: 15 },
          { ext: '.docx', count: 10 },
          { ext: '.xlsx', count: 10 },
          { ext: '.exe', count: 10 },
          { ext: '.url', count: 5 },
          { ext: '.zip', count: 5 }
        ],
        isDesktopPath: true
      }

      const recs = recommendWorkflowByProfile(desktopStats, BLUEPRINT_STATIC_TEMPLATES)
      expect(recs.length).toBeGreaterThan(0)
      const topRec = recs[0]
      expect([
        'builtin.workflow.desktop-declutter',
        'builtin.workflow.desktop-classic-classification'
      ]).toContain(topRec.workflowId)
      expect(topRec.score).toBeGreaterThanOrEqual(85)
    })
  })
})
