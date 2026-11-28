/**
 * KeepAlive 视图可见性上下文（R-23 / D-08 渐进式方案）
 *
 * 轻量可见性广播：App 的 KeepAlive 包装层按 pathname 门禁提供 `visible`，
 * 隐藏视图的后代组件可经 `useViewVisible()` 订阅可见性以暂停轮播/测量等后台工作。
 *
 * 边界铁律：
 * - 不替代 pathname 门禁，不改动 `transition-opacity duration-200` 隐藏动画；
 * - 不采用 React 19.2 `<Activity>`（会切 display:none 破坏 200ms 过渡并卸载 IPC 监听）；
 * - 默认值 `true`：未包裹 Provider 的宿主（独立预览窗/队列窗/单测）按可见处理。
 */
import { createContext, useContext } from 'react'

export const ViewVisibilityContext = createContext<boolean>(true)

/** 订阅当前 KeepAlive 视图可见性（无 Provider 时恒为 true） */
export const useViewVisible = (): boolean => useContext(ViewVisibilityContext)
