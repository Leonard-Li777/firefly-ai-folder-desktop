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
import { LOCAL_WORKFLOW_SOURCE } from '../../../config/local-workflow-source'

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
      expect([
        useCaseA.expected.topWorkflowId,
        'builtin.workflow.desktop-classic-classification'
      ]).toContain(top.workflowId)
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
      expect([
        'builtin.workflow.office-finance',
        'builtin.workflow.finance-contract',
        'builtin.workflow.freelance-business-delivery'
      ]).toContain(financeRes[0].workflowId)
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
      const results = recommendWorkflowByProfile(stats)
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
        const bp = LOCAL_WORKFLOW_SOURCE().find(t => t.id === wfId)
        expect(bp).toBeDefined()
        const includeRules = bp?.workspace_config?.customIncludeRules || []
        const commonExts = includeRules.filter(r => r.type === 'extension').map(r => r.value)
        const excludeRules = bp?.workspace_config?.customExcludeRules || []
        const ignores = excludeRules.filter(r => r.type === 'extension').map(r => r.value)
        const weights = bp?.workspace_config?.extensionWeights || {}

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

      const recs = recommendWorkflowByProfile(desktopStats)
      expect(recs.length).toBeGreaterThan(0)
      const topRec = recs[0]
      expect([
        'builtin.workflow.desktop-declutter',
        'builtin.workflow.desktop-classic-classification'
      ]).toContain(topRec.workflowId)
      expect(topRec.score).toBeGreaterThanOrEqual(85)
    })

    it('AC-05: 格式正交下的全漏斗穿透、防通用流反客为主与灵敏度 30 / 封顶 85 验证', () => {
      // 场景：单样本冷启动 (1 个 .fountain 剧本文件)，所有官方模板均未收录 .fountain
      const singleSampleNovelStats: DirectoryProfileStats = {
        totalFiles: 1,
        totalSampled: 1,
        countsByExt: { fountain: 1 },
        topExtensions: [{ ext: '.fountain', count: 1 }],
        // 模拟 Stage B 端侧语义匹配：写作出版流显著拔尖解锁，余弦/置信度给出极高语义分 (0.95)
        semanticScoresByWorkflowId: {
          'builtin.workflow.writing-publishing-pipeline': 0.95
        },
        unlockedWorkflowIds: ['builtin.workflow.writing-publishing-pipeline']
      }

      const recs = recommendWorkflowByProfile(singleSampleNovelStats)
      expect(recs.length).toBeGreaterThan(0)

      // 1. 验证穿透全漏斗：首选必须是写作出版流，而非通用归档兜底
      const topRec = recs[0]
      expect(topRec.workflowId).toBe('builtin.workflow.writing-publishing-pipeline')
      expect(topRec.reasonCode).not.toBe('insufficient_samples')
      expect(topRec.reasonCode).not.toBe('empty_directory')
      expect(topRec.reasonCode).not.toBe('zero_extension_match')

      // 2. 验证灵敏度乘数 30 加成使得零扩展名样本得分成功超越通用流基准 (55 分)，并赋予语义推荐原因码
      expect(topRec.score).toBeGreaterThan(55)
      expect(topRec.score).toBeLessThanOrEqual(85)
      expect(topRec.reasonCode).toBe('semantic_filename_boost')
      expect(topRec.matchReason).toContain('结合目录语义与抽样文件名特征')

      // 3. 验证通用流被成功压制，绝未拉升至 75 分反客为主抢占 Top 1
      const universalRec = recs.find(r => r.workflowId === 'builtin.workflow.universal-inbox')
      if (universalRec) {
        expect(universalRec.score).toBe(55)
      }
    })

    it('回归场景: 45% 快捷方式与链接 (.lnk/.url) + 多模态杂散（含偶发 .epub 与 Stage B 噪声）必须首推桌面工作流，绝不误推菜谱库或非桌面垂直流', () => {
      const desktopIds = [
        'builtin.workflow.desktop-declutter',
        'builtin.workflow.desktop-classic-classification'
      ]

      // 场景 1: .lnk 45% + 1 个偶发 .epub + 杂散文档/图片/音视频/代码，即使路径未命名为 Desktop
      const lnkWithEpubStats: DirectoryProfileStats = {
        totalFiles: 100,
        totalSampled: 100,
        countsByExt: {
          '.lnk': 45,
          '.png': 11,
          '.jpg': 10,
          '.docx': 9,
          '.xlsx': 5,
          '.pdf': 5,
          '.epub': 1,
          '.mp3': 6,
          '.js': 4,
          '.mp4': 2,
          '.txt': 2
        },
        isDesktopPath: false,
        isDownloadsPath: false,
        // 模拟 Stage B 杂乱软件名引发的温和噪声（未解锁）
        semanticScoresByWorkflowId: {
          'builtin.workflow.cooking-recipes-vault': 0.78,
          'builtin.workflow.desktop-declutter': 0.25,
          'builtin.workflow.desktop-classic-classification': 0.25
        },
        unlockedWorkflowIds: []
      }
      const res1 = recommendWorkflowByProfile(lnkWithEpubStats)
      expect(desktopIds).toContain(res1[0].workflowId)
      expect(res1[0].score).toBeGreaterThanOrEqual(80)
      // 前 5 名中不应出现将 .lnk 列为排除名单却误获桌面加成的垂直工作流高分篡位
      const cookingRec1 = res1.find(r => r.workflowId === 'builtin.workflow.cooking-recipes-vault')
      if (cookingRec1) {
        expect(cookingRec1.score).toBeLessThanOrEqual(68)
      }
      const legalRec1 = res1.find(r => r.workflowId === 'builtin.workflow.legal-case-dossier')
      if (legalRec1) {
        expect(legalRec1.reasonCode).not.toBe('desktop_declutter')
        expect(legalRec1.score).toBeLessThanOrEqual(68)
      }

      // 场景 2: 快捷方式与链接全为 .url (45%)，不含 .lnk，验证聚合统计 SHORTCUT_EXTS 同样稳推桌面工作流
      const urlOnlyStats: DirectoryProfileStats = {
        totalFiles: 98,
        totalSampled: 98,
        countsByExt: {
          '.url': 45,
          '.png': 11,
          '.jpg': 10,
          '.docx': 10,
          '.xlsx': 5,
          '.pdf': 5,
          '.mp3': 6,
          '.js': 4,
          '.mp4': 2
        },
        isDesktopPath: false,
        isDownloadsPath: false
      }
      const res2 = recommendWorkflowByProfile(urlOnlyStats)
      expect(desktopIds).toContain(res2[0].workflowId)
      expect(res2[0].score).toBeGreaterThanOrEqual(80)
      expect(res2[0].workflowId).not.toBe('builtin.workflow.cooking-recipes-vault')
    })

    it('回归场景: TS/JS/HTML/JSON/MD 前端代码项目 (无 .tsx/.vue/.kt/.h) 必须稳推代码工作流 T2 (>=85分)，绝不落入通用数字资产或菜谱', () => {
      const codeProjectStats: DirectoryProfileStats = {
        totalFiles: 129,
        totalSampled: 129,
        countsByExt: {
          md: 48,
          json: 27,
          yaml: 2,
          html: 15,
          ts: 13,
          js: 7,
          ico: 1,
          txt: 1,
          jpg: 4,
          png: 6,
          webp: 1
        }
      }
      const recs = recommendWorkflowByProfile(codeProjectStats)
      expect([
        'builtin.workflow.code-asset-vault',
        'builtin.workflow.frontend-dev',
        'builtin.workflow.backend-arch'
      ]).toContain(recs[0].workflowId)
      expect(recs[0].tier).toBe('T2')
      expect(recs[0].score).toBeGreaterThanOrEqual(85)
      expect(recs[0].workflowId).not.toBe('builtin.workflow.para-universal')
      expect(recs[0].workflowId).not.toBe('builtin.workflow.cooking-recipes-vault')
    })

    it('回归场景: 音乐收藏目录 (.flac + .mp3 + .lrc + .jpg) 前 3 名必须包含音乐与影音收藏工作流，绝不被长辈档案等杂项抢占', () => {
      const musicCollectionStats: DirectoryProfileStats = {
        totalFiles: 300,
        totalSampled: 300,
        countsByExt: {
          flac: 63,
          lrc: 133,
          mp3: 87,
          jpg: 16,
          ini: 1
        }
      }
      const recs = recommendWorkflowByProfile(musicCollectionStats)
      const top3Ids = recs.slice(0, 3).map(r => r.workflowId)
      expect(top3Ids).toContain('builtin.workflow.music-audio')
      expect(top3Ids).toContain('builtin.workflow.media-collector-vault')
      expect(top3Ids).toContain('builtin.workflow.movie-cinema')
      // 影音收藏库必须处于高分阵营 (>= 85)，显著领先长辈生活档案等 T3 模板
      const mediaRec = recs.find(r => r.workflowId === 'builtin.workflow.media-collector-vault')
      const movieRec = recs.find(r => r.workflowId === 'builtin.workflow.movie-cinema')
      expect(mediaRec?.score).toBeGreaterThanOrEqual(85)
      expect(movieRec?.score).toBeGreaterThanOrEqual(85)
      const seniorRec = recs.find(r => r.workflowId === 'builtin.workflow.senior-life-archive')
      if (seniorRec) {
        expect(seniorRec.score).toBeLessThan(70)
      }
    })

    it('回归场景: 纯 .txt 科幻小说目录在 Stage B 语义解锁后，小说与电子书书库稳居榜首并击败通用数字资产管理体系', () => {
      const sciFiNovelStats: DirectoryProfileStats = {
        totalFiles: 251,
        totalSampled: 251,
        countsByExt: { txt: 249, downloading: 1, jpg: 1 },
        semanticScoresByWorkflowId: {
          'builtin.workflow.novel': 0.95,
          'builtin.workflow.para-universal': 0.4,
          'builtin.workflow.johnny-decimal': 0.4
        },
        unlockedWorkflowIds: ['builtin.workflow.novel']
      }
      const recs = recommendWorkflowByProfile(sciFiNovelStats)
      expect(recs[0].workflowId).toBe('builtin.workflow.novel')
      expect(recs[0].score).toBeGreaterThanOrEqual(70)
      expect(recs[0].score - (recs[1]?.score ?? 0)).toBeGreaterThanOrEqual(15)
    })

    it('回归场景: 多项目创意混合目录 (图/文/视频/JSON/ZIP) 未语义解锁时，宠物档案/菜谱库等零专属垂类恒封顶 <=70，绝不误推数据分析或宠物/菜谱', () => {
      const mixedCreativeProjects: DirectoryProfileStats = {
        totalFiles: 126,
        totalSampled: 126,
        countsByExt: {
          zip: 4,
          txt: 11,
          pdf: 9,
          docx: 1,
          jpg: 17,
          psd: 4,
          json: 27,
          mp3: 3,
          mp4: 16,
          png: 22,
          webp: 1,
          ico: 1,
          db: 1,
          gif: 1,
          svg: 2,
          md: 1,
          xlsx: 5
        }
      }
      const recs = recommendWorkflowByProfile(mixedCreativeProjects)
      expect(recs[0].workflowId).not.toBe('builtin.workflow.pet-care-diary')
      expect(recs[0].workflowId).not.toBe('builtin.workflow.cooking-recipes-vault')
      expect(recs[0].workflowId).not.toBe('builtin.workflow.data-science-analytics')
      for (const weakId of [
        'builtin.workflow.pet-care-diary',
        'builtin.workflow.cooking-recipes-vault',
        'builtin.workflow.senior-life-archive'
      ]) {
        const hit = recs.find(r => r.workflowId === weakId)
        if (hit) {
          expect(hit.score).toBeLessThanOrEqual(70)
        }
      }
    })

    it('回归场景: Download 下载目录含少量 .log/.inf 与多个 .apk 时，必须首推下载文件夹自动分类 (99分)，严禁 2 个 .log 篡位 T1 倒挂，且手机开发/硬件装机绝不虚高', () => {
      const downloadStats: DirectoryProfileStats = {
        totalFiles: 265,
        totalSampled: 265,
        countsByExt: {
          zip: 82,
          exe: 50,
          apk: 20,
          png: 14,
          pdf: 9,
          sys: 9,
          cat: 8,
          inf: 8,
          mp4: 8,
          txt: 8,
          '7z': 7,
          xlsx: 5,
          html: 5,
          msi: 3,
          jpeg: 3,
          'tar.xz': 3,
          json: 3,
          md: 2,
          gz: 2,
          log: 2,
          'tar.gz': 2,
          ico: 2,
          ini: 1,
          rpm: 1,
          onnx: 1,
          jpg: 1,
          iso: 1,
          docx: 1,
          ods: 1,
          icns: 1,
          pyobj: 1,
          rar: 1
        },
        isDownloadsPath: true,
        isDesktopPath: false,
        semanticScoresByWorkflowId: {
          'builtin.workflow.downloads-triage': 0.96,
          'builtin.workflow.mobile-app-dev': 0.88,
          'builtin.workflow.pc-hardware-gear': 0.78,
          'builtin.workflow.system-cache-appdata-vault': 0.2
        },
        unlockedWorkflowIds: [
          'builtin.workflow.downloads-triage',
          'builtin.workflow.mobile-app-dev'
        ]
      }
      const recs = recommendWorkflowByProfile(downloadStats)
      expect(recs[0].workflowId).toBe('builtin.workflow.downloads-triage')
      expect(recs[0].score).toBe(99)
      expect(recs[0].score - (recs[1]?.score ?? 0)).toBeGreaterThanOrEqual(15)
      // 严禁仅 2 个 .log (0.75%) 晋升 T1 倒挂 99 分
      expect(recs[0].workflowId).not.toBe('builtin.workflow.system-cache-appdata-vault')
      // 严禁手机开发库借 .apk 拿 99 分或硬件装机库借 .exe/.zip+3%.inf 拿 83 分
      const mobileRec = recs.find(r => r.workflowId === 'builtin.workflow.mobile-app-dev')
      if (mobileRec) expect(mobileRec.score).toBeLessThanOrEqual(74)
      const pcRec = recs.find(r => r.workflowId === 'builtin.workflow.pc-hardware-gear')
      if (pcRec) expect(pcRec.score).toBeLessThanOrEqual(70)
    })
  })
})
