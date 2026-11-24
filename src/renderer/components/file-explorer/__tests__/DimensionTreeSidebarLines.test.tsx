// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { DimensionTreeSidebar } from '../DimensionTreeSidebar'
import { DimensionGroup } from '@firefly/types'

// Mock ResizeObserver
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as any

global.IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as any

if (typeof window.PointerEvent === 'undefined') {
  ;(window as any).PointerEvent = class PointerEvent extends MouseEvent {}
}

;(window as any).electronAPI = {
  utils: {
    isPathEqual: (a: string, b: string) => a === b,
    normalizePath: (p: string) => p
  }
}

describe('DimensionTreeSidebar 树形引导线（showLine）与层级连线完整性测试', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('验证展开父标签时子级节点渲染祖先贯穿线（ancestor-v-line）与父级折角引导线，消除断裂', () => {
    // 构造类似用户场景的父子树形数据：
    // Group: 内容标签 (id: 28)
    //   - in (level 1, cluster parent, 3 children: executing, howto, interface)
    //   - ha (level 1, cluster parent, 3 children: character, flowchart, author)
    //   - mi (level 1, cluster parent, 1 child: xiaomi)
    const dimensionGroups: DimensionGroup[] = [
      {
        id: 28,
        name: '内容标签',
        code: 'builtin.content_tags',
        level: 0,
        tags: [
          {
            dimensionId: 28,
            dimensionCode: 'builtin.content_tags',
            dimensionName: '内容标签',
            tagValue: 'in',
            code: 'builtin.content_tags.cluster_in',
            codePath: '/builtin.content_tags/builtin.content_tags.cluster_in',
            level: 1,
            fileCount: 2,
            viaParentCode: 'builtin.content_tags',
            parentCodes: ['builtin.content_tags'],
            meta: { isClusterNode: true }
          },
          {
            dimensionId: 28,
            dimensionCode: 'builtin.content_tags',
            dimensionName: '内容标签',
            tagValue: 'executing',
            code: 'tag_executing',
            codePath: '/builtin.content_tags/builtin.content_tags.cluster_in/tag_executing',
            level: 2,
            fileCount: 1,
            viaParentCode: 'builtin.content_tags.cluster_in',
            parentCodes: ['builtin.content_tags.cluster_in']
          },
          {
            dimensionId: 28,
            dimensionCode: 'builtin.content_tags',
            dimensionName: '内容标签',
            tagValue: 'HOW-TO make Vin',
            code: 'tag_howto',
            codePath: '/builtin.content_tags/builtin.content_tags.cluster_in/tag_howto',
            level: 2,
            fileCount: 1,
            viaParentCode: 'builtin.content_tags.cluster_in',
            parentCodes: ['builtin.content_tags.cluster_in']
          },
          {
            dimensionId: 28,
            dimensionCode: 'builtin.content_tags',
            dimensionName: '内容标签',
            tagValue: 'interface',
            code: 'tag_interface',
            codePath: '/builtin.content_tags/builtin.content_tags.cluster_in/tag_interface',
            level: 2,
            fileCount: 1,
            viaParentCode: 'builtin.content_tags.cluster_in',
            parentCodes: ['builtin.content_tags.cluster_in']
          },
          {
            dimensionId: 28,
            dimensionCode: 'builtin.content_tags',
            dimensionName: '内容标签',
            tagValue: 'ha',
            code: 'builtin.content_tags.cluster_ha',
            codePath: '/builtin.content_tags/builtin.content_tags.cluster_ha',
            level: 1,
            fileCount: 3,
            viaParentCode: 'builtin.content_tags',
            parentCodes: ['builtin.content_tags'],
            meta: { isClusterNode: true }
          },
          {
            dimensionId: 28,
            dimensionCode: 'builtin.content_tags',
            dimensionName: '内容标签',
            tagValue: 'character',
            code: 'tag_char',
            codePath: '/builtin.content_tags/builtin.content_tags.cluster_ha/tag_char',
            level: 2,
            fileCount: 1,
            viaParentCode: 'builtin.content_tags.cluster_ha',
            parentCodes: ['builtin.content_tags.cluster_ha']
          }
        ]
      }
    ]

    const { container } = render(
      <DimensionTreeSidebar dimensionGroups={dimensionGroups} storageKey="test_tree_lines" />
    )

    // 检查是否有节点渲染
    const nodes = screen.getAllByTestId('dimension-tree-node')
    expect(nodes.length).toBeGreaterThan(0)

    // 找到 in 节点
    const inNode = nodes.find(n => n.getAttribute('data-node-id')?.includes('cluster_in'))
    expect(inNode).toBeDefined()

    // in 节点应具备折角引导线（从展开图标引向子级轴心，且 bottom: 0 避免高分屏裂缝）
    const cornerLine = inNode!.querySelector('[data-testid="corner-guide-h-line"]') as HTMLElement
    expect(cornerLine).not.toBeNull()
    expect(cornerLine.style.bottom).toBe('0px')

    // 找到 executing 子节点（depth 1）
    const executingNode = nodes.find(n => n.getAttribute('data-node-id')?.includes('tag_executing'))
    expect(executingNode).toBeDefined()

    // executing 子节点应该有贯穿祖先线（left: 8px）连接至其父节点同层兄弟（ha）
    const ancestorLines = executingNode!.querySelectorAll('.border-l')
    expect(ancestorLines.length).toBeGreaterThanOrEqual(1)

    // 验证不存在非法的 CSS 字符串 hsl(var(--muted-foreground) / 0.38)
    const allDivs = container.querySelectorAll('div')
    for (const d of allDivs) {
      expect(d.style.backgroundImage).not.toContain('hsl(var(--muted-foreground)')
    }
  })
})
