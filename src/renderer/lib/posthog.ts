import posthog from 'posthog-js/dist/module.full.no-external'
import { useTierStore } from '../stores/tier-store'

/**
 * PostHog 配置和初始化模块
 *
 * 提供用户行为分析、Session 录制、异常捕获等功能
 * 支持区分开发模式和生产模式
 */

const POSTHOG_KEY = typeof VITE_POSTHOG_KEY !== 'undefined' ? VITE_POSTHOG_KEY : ''
const POSTHOG_HOST =
  typeof VITE_POSTHOG_HOST !== 'undefined' ? VITE_POSTHOG_HOST : 'https://app.posthog.com'
const ENABLE_POSTHOG =
  typeof VITE_ENABLE_POSTHOG !== 'undefined' ? VITE_ENABLE_POSTHOG === 'true' : false
const IS_PACKAGED = typeof window !== 'undefined' && window.electronAPI?.isPackaged === true

/**
 * 暂停状态持久化
 *
 * posthog.opt_out_capturing() 会把 opt-out 状态持久化到 localStorage，而
 * isCapturingPaused 只是内存变量。若服务曾离线触发 opt-out，应用重启后
 * 内存状态丢失，即使服务器恢复也不会自动 opt-in，导致捕获被永久禁用。
 * 这里将暂停状态同步持久化，重启后即可恢复并自动重新开启捕获。
 */
const PAUSE_STORAGE_KEY = 'posthog_capture_paused'

const loadPausedState = (): boolean => {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(PAUSE_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

const savePausedState = (paused: boolean) => {
  if (typeof window === 'undefined') return
  try {
    if (paused) {
      window.localStorage.setItem(PAUSE_STORAGE_KEY, '1')
    } else {
      window.localStorage.removeItem(PAUSE_STORAGE_KEY)
    }
  } catch {
    // localStorage 不可用（如隐私模式）时忽略
  }
}

let isCapturingPaused = loadPausedState()
let checkInterval: NodeJS.Timeout | null = null

const checkServerReachability = async (): Promise<boolean> => {
  if (typeof window === 'undefined' || !window.navigator.onLine) {
    return false
  }
  try {
    const controller = new AbortController()
    const id = setTimeout(() => controller.abort(), 3000)

    // 探测接口是否可连通 (HEAD /)
    await fetch(POSTHOG_HOST, {
      method: 'HEAD',
      mode: 'no-cors',
      signal: controller.signal
    })
    clearTimeout(id)
    return true
  } catch (err) {
    return false
  }
}

/**
 * 初始化 PostHog — 先启动录制，再异步补充配置
 *
 * 关键优化：将 posthog.init() 提前到同步执行，确保 session recording
 * 在页面加载后立即启动，不被后续异步操作阻塞。
 */
export const initPostHog = async () => {
  // 只有 app.isPackaged（已打包）或显式开启 ENABLE_POSTHOG 时才允许放行
  if (!POSTHOG_KEY || (!IS_PACKAGED && !ENABLE_POSTHOG)) {
    if (!POSTHOG_KEY) {
      if (IS_PACKAGED) {
        console.error('PostHog API Key 未配置，生产环境下行为分析将不可用')
      } else {
        console.warn('PostHog API Key 未配置，开发环境下将跳过初始化')
      }
    } else if (!IS_PACKAGED && !ENABLE_POSTHOG) {
      console.log('PostHog 已配置但未开启（非打包环境默认关闭），使用 ENABLE_POSTHOG=true 开启')
    }
    return
  }

  // 立即初始化 PostHog（同步执行），不等待任何异步操作
  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    // 开发环境下开启调试模式，可以在浏览器控制台看到事件发送情况
    debug: !__IS_PROD__,
    // 捕获所有点击、表单提交等行为
    autocapture: true,
    // 开启 Session Recording — 立即生效
    session_recording: {
      // 不默认掩码输入框与文本
      maskAllInputs: false,
      maskInputOptions: {
        password: true
      },
      // 完全屏蔽带有这些类名的元素（录制中显示为黑色色块）
      blockClass: 'ph-no-capture',
      // 对带有这些类名的元素文本打码（录制中显示为 ***）
      maskTextClass: 'ph-mask'
    },
    // 开启异常捕获
    capture_exceptions: true,
    // 自动捕获页面浏览
    capture_pageview: 'history_change',
    // 持久化标识
    persistence: 'localStorage+cookie',
    // 在发送前修改事件数据
    before_send: event => {
      // 注入环境标记，确保即便手动 capture 漏掉也会补上
      if (event?.properties) {
        event.properties['运行环境'] = __IS_PROD__ ? '生产环境' : '开发环境'
      }
      return event
    }
  })

  // 注册全局属性，确保每个事件都带上环境标识
  posthog.register({
    运行环境: __IS_PROD__ ? '生产环境' : '开发环境'
  })

  // 动态监控服务器连通性，离线时停止 PostHog 以免产生大量网络报错
  const checkConnection = async () => {
    const isReachable = await checkServerReachability()
    if (!isReachable) {
      if (!isCapturingPaused) {
        console.warn('PostHog: 检测到分析服务器离线，已暂停事件捕获以避免请求报错')
        posthog.opt_out_capturing()
        isCapturingPaused = true
        savePausedState(true)
      }
    } else {
      if (isCapturingPaused) {
        // 在重新启用捕获前，还要确认没有被 telemetry 禁用
        const { computed_limits } = useTierStore.getState()
        if (computed_limits?.telemetry !== false) {
          console.log('PostHog: 检测到分析服务器已恢复，重新开启事件捕获')
          posthog.opt_in_capturing()
          isCapturingPaused = false
          savePausedState(false)
        }
      }
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('online', checkConnection)
    window.addEventListener('offline', checkConnection)
    if (checkInterval) clearInterval(checkInterval)
    checkInterval = setInterval(checkConnection, 30000)
    // 立即启动连通性判定
    checkConnection()
  }

  // 异步补充配置（不阻塞 session recording）：
  // 1. telemetry 门控检查（如果是企业版，后续停用追踪）
  // 2. 机器 ID 识别
  Promise.resolve().then(async () => {
    try {
      // 通过 tier store 获取 computed_limits.telemetry 门控
      const tierStore = useTierStore.getState()
      // 确保 tier 数据已加载
      if (!tierStore.tier || tierStore.isLoading) {
        await tierStore.fetchProfile()
      }
      const { computed_limits } = useTierStore.getState()
      if (computed_limits?.telemetry === false) {
        console.log('PostHog: 检测到 telemetry 门控禁用，停止追踪')
        posthog.opt_out_capturing()
        isCapturingPaused = true
        savePausedState(true)
        return
      }
    } catch (e) {
      console.warn('PostHog: tier 数据读取失败', e)
    }

    try {
      const machineId = await window.electronAPI!.getMachineId()
      if (machineId) {
        posthog.identify(machineId)
        // 设置用户属性
        posthog.setPersonProperties({
          machine_id: machineId,
          app_version: __APP_VERSION__,
          platform: window.navigator.platform,
          last_environment: __IS_PROD__ ? '生产环境' : '开发环境'
        })
      }
    } catch (error) {
      console.error('无法获取机器 ID 进行 PostHog 身份识别:', error)
    }
  })

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
    运行环境: __IS_PROD__ ? '生产环境' : '开发环境',
    ...properties
  }

  try {
    if (posthog && typeof posthog.capture === 'function') {
      posthog.capture(eventName, finalProps)
    } else if (!__IS_PROD__) {
      console.log(`[PostHog Skip] 事件: ${eventName}`, finalProps)
    }
  } catch (e) {
    if (!__IS_PROD__) console.warn(`PostHog 事件捕获失败 [${eventName}]:`, e)
  }
}

/**
 * 捕获异常
 * @param error 错误对象
 * @param properties 额外属性
 */
export const captureException = (error: Error, properties?: Record<string, any>) => {
  const finalProps = {
    运行环境: __IS_PROD__ ? '生产环境' : '开发环境',
    ...properties
  }

  try {
    if (posthog && typeof posthog.captureException === 'function') {
      posthog.captureException(error, finalProps)
    } else if (!__IS_PROD__) {
      console.log(`[PostHog Skip] 异常:`, error, finalProps)
    }
  } catch (e) {
    if (!__IS_PROD__) console.warn('PostHog 异常捕获失败:', e)
  }
}

export default posthog
