/**
 * 校验 README.md / README_EN.md 中所有本地图片引用是否真实存在
 * 避免出现引用断裂（图片在 GitHub 上显示为破损图标）
 *
 * 使用方式：node apps/desktop/scripts/verify-readme-images.mjs
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const desktopRoot = path.resolve(__dirname, '..')

const readmeFiles = ['README.md', 'README_EN.md']
const rows = []
let broken = 0

for (const name of readmeFiles) {
  const filePath = path.join(desktopRoot, name)
  if (!fs.existsSync(filePath)) continue

  const content = fs.readFileSync(filePath, 'utf8')
  const matches = content.matchAll(/src="(\.\/assets\/[^"]+)"/g)
  const seen = new Set()

  for (const match of matches) {
    const relative = match[1]
    if (seen.has(relative)) continue
    seen.add(relative)

    const absolute = path.join(desktopRoot, relative)
    const exists = fs.existsSync(absolute)
    if (!exists) broken += 1
    rows.push({
      readme: name,
      asset: relative.replace('./assets/', ''),
      exists: exists ? '✓' : '✗ 缺失',
      size: exists ? `${(fs.statSync(absolute).size / 1024).toFixed(1)} KiB` : '-'
    })
  }
}

console.table(rows)
console.log(
  broken === 0
    ? `[verify] 全部 ${rows.length} 条本地引用均有效`
    : `[verify] 发现 ${broken} 条断裂引用，请检查！`
)
if (broken > 0) process.exit(1)
