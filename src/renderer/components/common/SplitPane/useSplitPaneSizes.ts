import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { SplitPaneSection } from './types'

const STORAGE_PREFIX = 'split-pane:'

function getActualStorageKey(key: string, rawKey?: boolean): string {
  if (!key) return ''
  if (rawKey || key.startsWith(STORAGE_PREFIX) || key.startsWith('hub_split_v1_')) {
    return key
  }
  return STORAGE_PREFIX + key
}

function loadFromStorage(storageKey: string, rawKey?: boolean): Record<string, number> {
  try {
    const actualKey = getActualStorageKey(storageKey, rawKey)
    const raw = actualKey ? localStorage.getItem(actualKey) : null
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function saveToStorage(storageKey: string, sizes: Record<string, number>, rawKey?: boolean) {
  try {
    const actualKey = getActualStorageKey(storageKey, rawKey)
    if (actualKey) {
      localStorage.setItem(actualKey, JSON.stringify(sizes))
    }
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

function clearStorage(storageKey: string, rawKey?: boolean) {
  try {
    const actualKey = getActualStorageKey(storageKey, rawKey)
    if (actualKey) {
      localStorage.removeItem(actualKey)
    }
  } catch {
    // silently ignore
  }
}

export function useSplitPaneSizes(
  storageKey: string,
  sections: SplitPaneSection[],
  options?: { rawKey?: boolean }
) {
  const rawKey = options?.rawKey ?? false
  // 缓存 section IDs 的字符串表示
  const sectionIdsStr = useMemo(() => sections.map(s => s.id).join(','), [sections])

  // 将存储键与当前的布局模式绑定，防止不同布局尺寸相互污染；若开启 rawKey 则直接使用 storageKey
  const compositeStorageKey = useMemo(() => {
    if (!storageKey) return ''
    return rawKey ? storageKey : `${storageKey}:${sectionIdsStr}`
  }, [storageKey, sectionIdsStr, rawKey])

  // 加载初始大小 (React 只在首次挂载时执行此初始化函数)
  const getInitialSizes = () => {
    const stored = compositeStorageKey ? loadFromStorage(compositeStorageKey, rawKey) : {}
    return sections.reduce<Record<string, number>>((acc, sec) => {
      acc[sec.id] = stored[sec.id] ?? sec.defaultSize
      return acc
    }, {})
  }

  const [sizes, setSizes] = useState<Record<string, number>>(getInitialSizes)
  const sizesRef = useRef<Record<string, number>>(sizes)
  sizesRef.current = sizes

  // 跟踪上一次的 compositeStorageKey
  const prevCompositeKeyRef = useRef<string>(compositeStorageKey)

  // 当 compositeStorageKey 发生变化（包括布局栏目增减）时，
  // 尝试从新 Key 对应的存储中恢复，如无存储则使用默认值，避免溢出与拖拽失效
  useEffect(() => {
    if (compositeStorageKey !== prevCompositeKeyRef.current) {
      const stored = compositeStorageKey ? loadFromStorage(compositeStorageKey, rawKey) : {}
      const targetSizes = sections.reduce<Record<string, number>>((acc, sec) => {
        acc[sec.id] = stored[sec.id] ?? sec.defaultSize
        return acc
      }, {})
      setSizes(targetSizes)
      sizesRef.current = targetSizes
      prevCompositeKeyRef.current = compositeStorageKey
    }
  }, [compositeStorageKey, sections, rawKey])

  const getSize = useCallback(
    (id: string) => sizes[id] ?? sections.find(s => s.id === id)?.defaultSize ?? 0,
    [sizes, sections]
  )

  const setSize = useCallback(
    (id: string, value: number | ((prev: number) => number)) => {
      setSizes(prev => {
        const current = prev[id] ?? 0
        const nextVal = typeof value === 'function' ? value(current) : value
        const next = { ...prev, [id]: Math.round(nextVal * 10000) / 10000 }
        sizesRef.current = next
        if (compositeStorageKey) {
          saveToStorage(compositeStorageKey, next, rawKey)
        }
        return next
      })
    },
    [compositeStorageKey, rawKey]
  )

  const batchSetSizes = useCallback(
    (updater: (prev: Record<string, number>) => Record<string, number>) => {
      setSizes(prev => {
        const next = updater(prev)
        sizesRef.current = next
        if (compositeStorageKey) {
          saveToStorage(compositeStorageKey, next, rawKey)
        }
        return next
      })
    },
    [compositeStorageKey, rawKey]
  )

  const flushStorage = useCallback(() => {
    if (compositeStorageKey) {
      saveToStorage(compositeStorageKey, sizesRef.current, rawKey)
    }
  }, [compositeStorageKey, rawKey])

  return { sizes, getSize, setSize, batchSetSizes, flushStorage }
}
