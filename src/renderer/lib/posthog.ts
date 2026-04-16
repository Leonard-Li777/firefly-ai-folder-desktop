import posthog from 'posthog-js/dist/module.full.no-external'

/**
 * PostHog 配置和初始化模块
 * 
 * 提供用户行为分析、Session 录制、异常捕获等功能
 * 支持区分开发模式和生产模式
 */

// 这些变量由 electron-vite 通过 define 注入
declare const VITE_POSTHOG_KEY: string
declare const VITE_POSTHOG_HOST: string
declare const VITE_ENABLE_POSTHOG: string
declare const IS_PROD: boolean
declare const __APP_VERSION__: string

const POSTHOG_KEY = typeof VITE_POSTHOG_KEY !== 'undefined' ? VITE_POSTHOG_KEY : ''
const POSTHOG_HOST = typeof VITE_POSTHOG_HOST !== 'undefined' ? VITE_POSTHOG_HOST : 'https://app.posthog.com'
const ENABLE_POSTHOG = typeof VITE_ENABLE_POSTHOG !== 'undefined' ? VITE_ENABLE_POSTHOG === 'true' : false

/**
 * 初始化 PostHog
 */
export const initPostHog = async () => {
  // 如果没有 Key，或者在开发环境下未显式开启，则跳过
  if (!POSTHOG_KEY || (!IS_PROD && !ENABLE_POSTHOG)) {
    if (!POSTHOG_KEY) {
      if (IS_PROD) {
        console.error('PostHog API Key 未配置，生产环境下行为分析将不可用')
      } else {
        console.warn('PostHog API Key 未配置，开发环境下将跳过初始化')
      }
    } else if (!IS_PROD && !ENABLE_POSTHOG) {
      console.log('PostHog 已配置但未开启（开发环境默认关闭），使用 start:debug-posthog 开启')
    }
    return
  }

  // 初始化 PostHog
  // 类型定义可能不匹配完整包，但功能正常
  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    // 开发环境下开启调试模式，可以在浏览器控制台看到事件发送情况
    debug: !IS_PROD,
    // 捕获所有点击、表单提交等行为
    autocapture: true,
    // 开启 Session Recording
    session_recording: {
      // 默认开启最高级别脱敏
      maskAllInputs: true,
      // 完全屏蔽带有这些类名的元素（录制中显示为黑色色块）
      blockClass: 'ph-no-capture',
      // 对带有这些类名的元素文本打码（录制中显示为 ***）
      maskTextClass: 'ph-mask',
    },
    // 开启异常捕获
    capture_exceptions: true,
    // 自动捕获页面浏览
    capture_pageview: 'history_change',
    // 持久化标识
    persistence: 'localStorage+cookie',
    // 在发送前修改事件数据
    before_send: (event) => {
      // 注入环境标记，确保即便手动 capture 漏掉也会补上
      if (event?.properties) {
        event.properties['运行环境'] = IS_PROD ? '生产环境' : '开发环境'
      }
      return event
    }
  })

  // 注册全局属性，确保每个事件都带上环境标识
  posthog.register({
    '运行环境': IS_PROD ? '生产环境' : '开发环境'
  })

  // 关联机器 ID 作为用户唯一标识
  try {
    const machineId = await window.electronAPI!.getMachineId()
    if (machineId) {
      posthog.identify(machineId)
      // 设置用户属性
      posthog.setPersonProperties({
        machine_id: machineId,
        app_version: __APP_VERSION__, 
        platform: window.navigator.platform,
        last_environment: IS_PROD ? '生产环境' : '开发环境'
      })
    }
  } catch (error) {
    console.error('无法获取机器 ID 进行 PostHog 身份识别:', error)
  }

  return posthog
}

/**
 * 捕获自定义事件
 * @param eventName 事件名称
 * @param properties 额外属性
 */
export const captureEvent = (eventName: string, properties?: Record<string, any>) => {
  // 确保注入环境信息
  const finalProps = {
    '运行环境': IS_PROD ? '生产环境' : '开发环境',
    ...properties
  }
  
  try {
    if (posthog && typeof posthog.capture === 'function') {
      posthog.capture(eventName, finalProps)
    } else if (!IS_PROD) {
      console.log(`[PostHog Skip] 事件: ${eventName}`, finalProps)
    }
  } catch (e) {
    if (!IS_PROD) console.warn(`PostHog 事件捕获失败 [${eventName}]:`, e)
  }
}

/**
 * 捕获异常
 * @param error 错误对象
 * @param properties 额外属性
 */
export const captureException = (error: Error, properties?: Record<string, any>) => {
  const finalProps = {
    '运行环境': IS_PROD ? '生产环境' : '开发环境',
    ...properties
  }

  try {
    if (posthog && typeof posthog.captureException === 'function') {
      posthog.captureException(error, finalProps)
    } else if (!IS_PROD) {
      console.log(`[PostHog Skip] 异常:`, error, finalProps)
    }
  } catch (e) {
    if (!IS_PROD) console.warn('PostHog 异常捕获失败:', e)
  }
}

export default posthog
