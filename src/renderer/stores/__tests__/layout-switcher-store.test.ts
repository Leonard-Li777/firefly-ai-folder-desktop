import { describe, it, expect, beforeEach } from 'vitest'
import {
  useLayoutSwitcherStore,
  resolveLayoutDecision,
  safeLayoutStorage,
  buildLayoutStorageKey
} from '../layout-switcher-store'
import {
  PAGE_DEFAULT_LAYOUT,
  PAGE_LAYOUT_CAPABILITY,
  LAYOUT_KEYS,
  PANEL_IDS,
  resolveLayoutProjection,
  LAYOUT_PRESETS
} from '../../components/file-explorer/layout-switcher/types'
import { PAGE_IDS } from '../../constants/page-ids'
import type { WorkspaceConfigReady } from '@firefly/types'

describe('LayoutSwitcherStore & resolveLayoutDecision (Workflow Adaptive Layout)', () => {
  beforeEach(() => {
    // 清空内存与 store
    useLayoutSwitcherStore.setState({ userOverrides: {} })
    safeLayoutStorage.clearWorkspace('test-ws-1')
    safeLayoutStorage.clearWorkspace('test-ws-2')
  })

  describe('resolveLayoutDecision (3-Level Cascade Pipeline)', () => {
    it('Level 1: 命中用户显式覆盖时，权威采纳 (ADR-0062)', () => {
      const decision = resolveLayoutDecision({
        pageId: PAGE_IDS.REAL_DIRECTORY,
        workspaceId: 'test-ws-1',
        workspaceConfig: {
          schemaVersion: 1,
          status: 'ready',
          policyVersion: 1,
          defaultLayout: LAYOUT_KEYS.TRI,
          customExcludeRules: [],
          customIncludeRules: [],
          baseAIConfig: {} as any,
          configuredAt: 123456
        } as WorkspaceConfigReady,
        persistedUserLayout: {
          key: LAYOUT_KEYS.LIST_PREVIEW,
          visible: [PANEL_IDS.LIST, PANEL_IDS.PREVIEW]
        }
      })

      expect(decision.source).toBe('user')
      expect(decision.key).toBe(LAYOUT_KEYS.LIST_PREVIEW)
      expect(decision.visiblePanels).toContain(PANEL_IDS.LIST)
      expect(decision.visiblePanels).toContain(PANEL_IDS.PREVIEW)
    })

    it('Level 1 脏数据防护: 用户覆盖的 key 不在页面能力白名单内时，降级流转', () => {
      const decision = resolveLayoutDecision({
        pageId: PAGE_IDS.VIRTUAL_DIRECTORY, // VIRTUAL_DIRECTORY 不支持 all-column
        workspaceId: 'test-ws-1',
        workspaceConfig: {
          schemaVersion: 1,
          status: 'ready',
          policyVersion: 1,
          defaultLayout: LAYOUT_KEYS.TRI,
          customExcludeRules: [],
          customIncludeRules: [],
          baseAIConfig: {} as any,
          configuredAt: 123456
        } as WorkspaceConfigReady,
        persistedUserLayout: {
          key: LAYOUT_KEYS.ALL_COLUMN, // 非法 key
          visible: [PANEL_IDS.LIST, PANEL_IDS.PREVIEW, PANEL_IDS.DETAILS]
        }
      })

      // 降级到 Level 2 工作流推荐布局
      expect(decision.source).toBe('workflow')
      expect(decision.key).toBe(LAYOUT_KEYS.TRI)
    })

    it('Level 2: 用户无覆盖时，忠实采纳工作流配置的 defaultLayout', () => {
      const decision = resolveLayoutDecision({
        pageId: PAGE_IDS.REAL_DIRECTORY,
        workspaceId: 'test-ws-1',
        workspaceConfig: {
          schemaVersion: 1,
          status: 'ready',
          policyVersion: 1,
          defaultLayout: LAYOUT_KEYS.TRI, // 如影视工作流
          customExcludeRules: [],
          customIncludeRules: [],
          baseAIConfig: {} as any,
          configuredAt: 123456
        } as WorkspaceConfigReady,
        persistedUserLayout: null
      })

      expect(decision.source).toBe('workflow')
      expect(decision.key).toBe(LAYOUT_KEYS.TRI)
      expect(decision.visiblePanels).toEqual([PANEL_IDS.LIST, PANEL_IDS.PREVIEW, PANEL_IDS.DETAILS])
    })

    it('Level 2 手机/相册工作流重载: defaultLayout 为 all-row 时正确采纳', () => {
      const decision = resolveLayoutDecision({
        pageId: PAGE_IDS.REAL_DIRECTORY,
        workspaceId: 'test-ws-1',
        workspaceConfig: {
          schemaVersion: 1,
          status: 'ready',
          policyVersion: 1,
          defaultLayout: LAYOUT_KEYS.ALL_ROW,
          customExcludeRules: [],
          customIncludeRules: [],
          baseAIConfig: {} as any,
          configuredAt: 123456
        } as WorkspaceConfigReady,
        persistedUserLayout: null
      })

      expect(decision.source).toBe('workflow')
      expect(decision.key).toBe(LAYOUT_KEYS.ALL_ROW)
    })

    it('Level 3: 无工作区配置或配置为 pending 时，回落至页面权威默认 PAGE_DEFAULT_LAYOUT', () => {
      const decision = resolveLayoutDecision({
        pageId: PAGE_IDS.REAL_DIRECTORY,
        workspaceId: null,
        workspaceConfig: null,
        persistedUserLayout: null
      })

      expect(decision.source).toBe('page_default')
      expect(decision.key).toBe(PAGE_DEFAULT_LAYOUT[PAGE_IDS.REAL_DIRECTORY])
      expect(decision.key).toBe(LAYOUT_KEYS.ALL_ROW)
    })
  })

  describe('useLayoutSwitcherStore 状态代数与穿透清扫', () => {
    it('setPageLayout 正确更新覆盖并写入安全存储', () => {
      const store = useLayoutSwitcherStore.getState()
      store.setPageLayout(PAGE_IDS.REAL_DIRECTORY, LAYOUT_KEYS.TRI, 'test-ws-1')

      const effective = store.getEffectiveLayout(PAGE_IDS.REAL_DIRECTORY, 'test-ws-1')
      expect(effective).toBe(LAYOUT_KEYS.TRI)

      const storedRaw = safeLayoutStorage.getItem(buildLayoutStorageKey(PAGE_IDS.REAL_DIRECTORY, 'test-ws-1'))
      expect(storedRaw).toBeTruthy()
      const parsed = JSON.parse(storedRaw!)
      expect(parsed.key).toBe(LAYOUT_KEYS.TRI)
      expect(parsed.visible).toEqual([PANEL_IDS.LIST, PANEL_IDS.PREVIEW, PANEL_IDS.DETAILS])
    })

    it('closePanel 拦截 list 关闭，允许关闭伴随格', () => {
      const store = useLayoutSwitcherStore.getState()
      store.setPageLayout(PAGE_IDS.REAL_DIRECTORY, LAYOUT_KEYS.ALL_ROW, 'test-ws-1')

      // 尝试关闭 list -> 拦截，list 依然在
      store.closePanel(PAGE_IDS.REAL_DIRECTORY, PANEL_IDS.LIST, 'test-ws-1')
      let visible = store.getVisiblePanels(PAGE_IDS.REAL_DIRECTORY, 'test-ws-1')
      expect(visible).toContain(PANEL_IDS.LIST)

      // 关闭 details -> details 被移除
      store.closePanel(PAGE_IDS.REAL_DIRECTORY, PANEL_IDS.DETAILS, 'test-ws-1')
      visible = store.getVisiblePanels(PAGE_IDS.REAL_DIRECTORY, 'test-ws-1')
      expect(visible).toEqual([PANEL_IDS.LIST, PANEL_IDS.PREVIEW])
    })

    it('openPanel 按确定性升级映射表平滑升级', () => {
      const store = useLayoutSwitcherStore.getState()
      // 当前为 list-only
      store.setPageLayout(PAGE_IDS.REAL_DIRECTORY, LAYOUT_KEYS.LIST_ONLY, 'test-ws-1')
      expect(store.getEffectiveLayout(PAGE_IDS.REAL_DIRECTORY, 'test-ws-1')).toBe(LAYOUT_KEYS.LIST_ONLY)

      // 打开 preview -> 升级至 list-preview
      store.openPanel(PAGE_IDS.REAL_DIRECTORY, PANEL_IDS.PREVIEW, 'test-ws-1')
      expect(store.getEffectiveLayout(PAGE_IDS.REAL_DIRECTORY, 'test-ws-1')).toBe(LAYOUT_KEYS.LIST_PREVIEW)
      expect(store.getVisiblePanels(PAGE_IDS.REAL_DIRECTORY, 'test-ws-1')).toEqual([
        PANEL_IDS.LIST,
        PANEL_IDS.PREVIEW
      ])

      // 在 list-preview 下再打开 details -> 升级至 all-row
      store.openPanel(PAGE_IDS.REAL_DIRECTORY, PANEL_IDS.DETAILS, 'test-ws-1')
      expect(store.getEffectiveLayout(PAGE_IDS.REAL_DIRECTORY, 'test-ws-1')).toBe(LAYOUT_KEYS.ALL_ROW)
      expect(store.getVisiblePanels(PAGE_IDS.REAL_DIRECTORY, 'test-ws-1')).toEqual([
        PANEL_IDS.LIST,
        PANEL_IDS.PREVIEW,
        PANEL_IDS.DETAILS
      ])
    })

    it('clearUserLayout 能够穿透清扫工作区在所有 Hub 页面上的手动覆盖', () => {
      const store = useLayoutSwitcherStore.getState()
      // 在真实目录与分析目录均设置覆盖
      store.setPageLayout(PAGE_IDS.REAL_DIRECTORY, LAYOUT_KEYS.TRI, 'test-ws-1')
      store.setPageLayout(PAGE_IDS.ANALYZED_DIRECTORY, LAYOUT_KEYS.LIST_ONLY, 'test-ws-1')

      expect(store.getEffectiveLayout(PAGE_IDS.REAL_DIRECTORY, 'test-ws-1')).toBe(LAYOUT_KEYS.TRI)
      expect(store.getEffectiveLayout(PAGE_IDS.ANALYZED_DIRECTORY, 'test-ws-1')).toBe(LAYOUT_KEYS.LIST_ONLY)

      // 切换工作流触发 clearUserLayout
      store.clearUserLayout('test-ws-1')

      // 传入特定工作流配置，验证已重置并生效工作流配置的 defaultLayout
      const wsConfig: WorkspaceConfigReady = {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 2,
        defaultLayout: LAYOUT_KEYS.PIN_LIST_TOP,
        customExcludeRules: [],
        customIncludeRules: [],
        baseAIConfig: {} as any,
        configuredAt: Date.now()
      }

      expect(store.getEffectiveLayout(PAGE_IDS.REAL_DIRECTORY, 'test-ws-1', wsConfig)).toBe(
        LAYOUT_KEYS.PIN_LIST_TOP
      )
      expect(store.getEffectiveLayout(PAGE_IDS.ANALYZED_DIRECTORY, 'test-ws-1', wsConfig)).toBe(
        LAYOUT_KEYS.PIN_LIST_TOP
      )
    })
  })

  describe('resolveLayoutProjection (Constant Tree Topology)', () => {
    it('三栏全开时，全部展开且方向正确', () => {
      const layout = LAYOUT_PRESETS[LAYOUT_KEYS.TRI]
      const projection = resolveLayoutProjection(layout, [
        PANEL_IDS.LIST,
        PANEL_IDS.PREVIEW,
        PANEL_IDS.DETAILS
      ])

      expect(projection.primaryDirection).toBe('horizontal')
      expect(projection.companionDirection).toBe('vertical')
      expect(projection.collapsed.companion).toBe(false)
      expect(projection.collapsed.preview).toBe(false)
      expect(projection.collapsed.details).toBe(false)
    })

    it('伴随面板全关时，companion 折叠', () => {
      const layout = LAYOUT_PRESETS[LAYOUT_KEYS.TRI]
      const projection = resolveLayoutProjection(layout, [PANEL_IDS.LIST])

      expect(projection.collapsed.companion).toBe(true)
      expect(projection.collapsed.preview).toBe(true)
      expect(projection.collapsed.details).toBe(true)
    })

    it('派生 unavailablePanels 时自动折叠对应面板', () => {
      const layout = LAYOUT_PRESETS[LAYOUT_KEYS.ALL_ROW]
      const projection = resolveLayoutProjection(
        layout,
        [PANEL_IDS.LIST, PANEL_IDS.PREVIEW, PANEL_IDS.DETAILS],
        new Set([PANEL_IDS.DETAILS]) // 属性格暂不可用
      )

      expect(projection.collapsed.companion).toBe(false)
      expect(projection.collapsed.preview).toBe(false)
      expect(projection.collapsed.details).toBe(true)
    })
  })
})
