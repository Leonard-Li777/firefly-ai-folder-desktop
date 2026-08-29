/**
 * 计算目录数限制 n（最大目录数）和 x（AI 自由新建目录数）
 *
 * 规则：
 * - n 算法：基于 sqrt(N) 曲线，下限 6（保证最小完整领域目录树结构），1000 左右封顶 30
 * - x 算法：n 的 25%，最少 1 个（6+2 语义：n 个参考目录 + x 个自由新建）
 *
 * @param totalFiles 待整理的文件总数
 * @returns 目录数限制（maxDirectoryCount）与 AI 自由新建数（freeDirectoryReserve）
 */
export function calculateDirectoryLimits(totalFiles: number): {
  maxDirectoryCount: number
  freeDirectoryReserve: number
} {
  // n 算法：基于 sqrt(N)，下限 6（保证最小完整领域目录树结构），1000 左右封顶 30
  let n = Math.round(Math.sqrt(totalFiles))
  n = Math.min(30, Math.max(6, n))

  // x 算法：n 的 25%，最少 1 个
  const x = Math.max(1, Math.round(n * 0.25))

  return { maxDirectoryCount: n, freeDirectoryReserve: x }
}
