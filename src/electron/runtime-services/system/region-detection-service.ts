/**
 * 地域与网络环境探测服务
 * 通过检测 google.com 和 baidu.com 的连接性，自动选择最优下载路径
 */

import { logger, LogCategory } from '@yonuc/shared'
import { net } from 'electron'
import { ConfigOrchestrator } from '../../config/config-orchestrator'

export class RegionDetectionService {
  private static instance: RegionDetectionService | null = null

  private constructor() {}

  static getInstance(): RegionDetectionService {
    if (!RegionDetectionService.instance) {
      RegionDetectionService.instance = new RegionDetectionService()
    }
    return RegionDetectionService.instance
  }

  /**
   * 执行连接性探测并更新配置
   */
  async detectAndSetMirror(): Promise<'cn' | 'global'> {
    logger.info(LogCategory.SYSTEM, '[Region] 正在通过探测 google.com 和 baidu.com 进行网络环境识别...')

    try {
      // 并行探测两个关键域名
      const [googleResult, baiduResult] = await Promise.all([
        this.testConnectivity('https://www.google.com'),
        this.testConnectivity('https://www.baidu.com')
      ])
      console.log({googleResult, baiduResult})
      // 决策逻辑：
      // 1. 如果能连通 Google，说明在国际网络环境，使用 global
      // 2. 如果不能连通 Google 但能连通百度，说明在国内环境，使用 cn
      // 3. 如果两者都不能连通，默认回退到 cn
      const mirror = baiduResult ? 'cn' : (googleResult ? 'global' : 'cn')
      
      logger.info(LogCategory.SYSTEM, `[Region] 探测完成。Google: ${googleResult ? '连通' : '失败'}, 百度: ${baiduResult ? '连通' : '失败'} -> 最终决策: ${mirror}`)
      
      // 更新全局配置
      ConfigOrchestrator.getInstance().updateValue('DOWNLOAD_MIRROR', mirror)
      
      return mirror
    } catch (error) {
      logger.error(LogCategory.SYSTEM, '[Region] 探测过程发生严重异常，默认回退至 cn:', error)
      ConfigOrchestrator.getInstance().updateValue('DOWNLOAD_MIRROR', 'cn')
      return 'cn'
    }
  }

  /**
   * 测试指定 URL 的连通性
   */
  private async testConnectivity(url: string): Promise<boolean> {
    return new Promise((resolve) => {
      let resolved = false
      
      // 5秒超时
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          resolve(false)
        }
      }, 5000)

      try {
        const request = net.request({
          url: url,
          method: 'HEAD',
          redirect: 'manual'
        })

        request.on('response', () => {
          if (!resolved) {
            resolved = true
            clearTimeout(timeout)
            resolve(true)
          }
        })

        request.on('error', (err) => {
          if (!resolved) {
            resolved = true
            clearTimeout(timeout)
            logger.debug(LogCategory.SYSTEM, `[Region] 探测 ${url} 失败: ${err.message}`)
            resolve(false)
          }
        })

        request.end()
      } catch (err) {
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          resolve(false)
        }
      }
    })
  }
}

export const regionDetectionService = RegionDetectionService.getInstance()
