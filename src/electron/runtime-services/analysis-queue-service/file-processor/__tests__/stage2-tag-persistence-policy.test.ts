import { describe, it, expect } from 'vitest'
import { shouldPersistStage2TagsBeforePhaseReturn } from '../stage2-tag-persistence-policy'

describe('shouldPersistStage2TagsBeforePhaseReturn', () => {
  it('returns false when preflightContext is absent regardless of phase or mode', () => {
    expect(shouldPersistStage2TagsBeforePhaseReturn('cpu', 'simple', false)).toBe(false)
    expect(shouldPersistStage2TagsBeforePhaseReturn('cpu', 'full', false)).toBe(false)
    expect(shouldPersistStage2TagsBeforePhaseReturn('all', 'full', false)).toBe(false)
  })

  it('persists Stage 2 tags for simple mode when running in split cpu phase', () => {
    expect(shouldPersistStage2TagsBeforePhaseReturn('cpu', 'simple', true)).toBe(true)
    expect(shouldPersistStage2TagsBeforePhaseReturn('cpu', 'quick_name', true)).toBe(true)
    expect(shouldPersistStage2TagsBeforePhaseReturn('cpu', 'full', true)).toBe(true)
  })

  it('defers simple mode persistence to the trailing simple branch when running in all phase', () => {
    expect(shouldPersistStage2TagsBeforePhaseReturn('all', 'simple', true)).toBe(false)
    expect(shouldPersistStage2TagsBeforePhaseReturn('all', 'quick_name', true)).toBe(true)
    expect(shouldPersistStage2TagsBeforePhaseReturn('all', 'full', true)).toBe(true)
  })
})
