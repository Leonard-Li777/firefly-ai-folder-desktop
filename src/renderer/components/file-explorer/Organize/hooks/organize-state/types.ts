import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { VirtualDirectory, VirtualDirectoryNode } from '@firefly/types'

export interface OrganizeCurrentVDirState {
  currentVDir: VirtualDirectory | null
  setCurrentVDir: Dispatch<SetStateAction<VirtualDirectory | null>>
}

export interface OrganizeSavedRefState {
  isSavedRef: MutableRefObject<boolean>
}

export interface OrganizeIncrementalState {
  incrementalVdId: number | null
  setIncrementalVdId: Dispatch<SetStateAction<number | null>>
  incrementalFiles: any[]
  setIncrementalFiles: Dispatch<SetStateAction<any[]>>
  initialDraftTree: VirtualDirectoryNode[]
  setInitialDraftTree: Dispatch<SetStateAction<VirtualDirectoryNode[]>>
}
