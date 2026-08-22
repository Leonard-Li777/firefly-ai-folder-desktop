import React from 'react'
import { AnalysisQueueContent } from './AnalysisQueueContent'

export function QueueWindowPage() {
  return (
    <div className="w-screen h-screen flex flex-col bg-background text-foreground overflow-hidden select-none">
      <AnalysisQueueContent mode="window" />
    </div>
  )
}
