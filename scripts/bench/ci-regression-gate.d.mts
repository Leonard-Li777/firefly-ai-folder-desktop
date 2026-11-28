import type {
  BenchReport,
  DelayInjectionComparison,
  RegressionGateOptions,
  RegressionGateResult
} from './types'

export declare function evaluateRelativeRegressionReport(
  current: BenchReport,
  baseline: BenchReport,
  options?: RegressionGateOptions
): RegressionGateResult

export declare function compareDelayInjectionReports(
  withDelay: BenchReport,
  withoutDelay: BenchReport
): DelayInjectionComparison
