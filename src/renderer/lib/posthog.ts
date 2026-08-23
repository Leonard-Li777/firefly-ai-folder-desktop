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
 * 初始化 PostHog
 *
 * 优化时序：
 * 主进程在创建窗口与渲染前已完成硬件资源探测与缓存，
 * 因此在前端执行 posthog.init() 时即可直接读取硬件评估结果，
 * 精准指定 disable_session_recording 状态（老核显直接禁用，高性能设备直接开启），
 * 避免二次动态切换与启动卡顿。
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

  // 1. 获取硬件检测结果（主进程在窗口加载前已检测就绪）与门控配置
  let hardwareInfo: any = null
  try {
    hardwareInfo = await window.electronAPI?.getHardwareInfo?.()
  } catch (hwErr) {
    console.warn('PostHog: 获取硬件信息失败:', hwErr)
  }

  const isHardwareEligible = hardwareInfo?.isSessionRecordingEligible ?? false
  const reason =
    hardwareInfo?.sessionRecordingReason ||
    (isHardwareEligible ? '硬件检测通过' : '未获取到硬件支持信息')

  // 2. 检查遥测门控（企业版等）
  let isTelemetryAllowed = true
  try {
    const tierStore = useTierStore.getState()
    if (!tierStore.tier && !tierStore.isLoading) {
      tierStore.fetchProfile().catch(() => {})
    }
    const { computed_limits } = useTierStore.getState()
    if (computed_limits?.telemetry === false) {
      isTelemetryAllowed = false
    }
  } catch {}

  const enableRecording = isHardwareEligible && isTelemetryAllowed

  console.log(
    `PostHog: 初始化启动，Session 录屏状态: ${enableRecording ? '已开启' : '已禁用'} (${reason})`
  )

  // 3. 立即带入精准的录屏配置初始化 PostHog
  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    // 开发环境下开启调试模式，可以在浏览器控制台看到事件发送情况
    debug: !__IS_PROD__,
    // 捕获所有点击、表单提交等行为
    autocapture: true,
    // 依据硬件检测结果精准设置录屏开关：低配老核显直接禁用，高性能设备直接开启
    disable_session_recording: !enableRecording,
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

  // 4. 注册全局属性，确保每个事件都带上环境标识
  posthog.register({
    运行环境: __IS_PROD__ ? '生产环境' : '开发环境'
  })

  // 5. 动态监控服务器连通性，离线时停止 PostHog 以免产生大量网络报错
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

  // 6. 异步补充身份识别（机器 ID）
  Promise.resolve().then(async () => {
    try {
      const machineId = await window.electronAPI!.getMachineId()
      if (machineId) {
        posthog.identify(machineId)
        // 设置用户属性
        posthog.setPersonProperties({
          machine_id: machineId,
          app_version: __APP_VERSION__,
          platform: window.navigator.platform,
          last_environment: __IS_PROD__ ? '生产环境' : '开发环境',
          gpu_model: hardwareInfo?.gpuModel || 'unknown',
          session_recording_enabled: enableRecording
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
