import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'
import { UpgradeAccountDialog } from './UpgradeAccountDialog'
import { useTierStore } from '../../stores/tier-store'
import { UserTier } from '@firefly/shared'
import { useConfigStore } from '../../stores/config-store'
import { DEFAULT_TIER_CONSTANTS } from '../../../../../../tests/unit/test-tier-constants'

vi.mock('@app/languages', () => ({
  t: (key: string) => key
}))

vi.mock('../../stores/tier-store', () => ({
  useTierStore: vi.fn()
}))

vi.mock('../../stores/config-store', () => ({
  useConfigStore: vi.fn()
}))

describe('UpgradeAccountDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(useConfigStore as any).mockImplementation((selector: any) =>
      selector({
        config: {
          TIER_CONSTANTS: DEFAULT_TIER_CONSTANTS,
          OPERATION_PRICES: {}
        }
      })
    )
  })

  it('should render three tiers', () => {
    ;(useTierStore as any).mockReturnValue({
      tier: UserTier.FREE,
      fetchProfile: vi.fn()
    })

    render(
      <MemoryRouter>
        <UpgradeAccountDialog open={true} onOpenChange={vi.fn()} />
      </MemoryRouter>
    )
    expect(screen.getByText('基础版')).toBeInTheDocument()
    expect(screen.getByText('Pro 专业版')).toBeInTheDocument()
    expect(screen.getByText('企业版')).toBeInTheDocument()
  })

  it('should show upgrade buttons for non-current tiers', () => {
    ;(useTierStore as any).mockReturnValue({
      tier: UserTier.FREE,
      fetchProfile: vi.fn()
    })

    render(
      <MemoryRouter>
        <UpgradeAccountDialog open={true} onOpenChange={vi.fn()} />
      </MemoryRouter>
    )
    // FREE 用户应该看到 Pro 和企业版的升级按钮
    const upgradeButtons = screen.getAllByText('立即升级')
    expect(upgradeButtons.length).toBeGreaterThanOrEqual(1)
  })
})
