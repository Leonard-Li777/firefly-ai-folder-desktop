import { AnalysisQueueService } from './analysis-queue-service'

export { AnalysisQueueService }
export * from './types'

export const analysisQueueService = new AnalysisQueueService()
export default analysisQueueService
