/**
 * 同步 README.md / README_EN.md 中的本地图片引用为 .webp
 *
 * 规则：
 * - 仅替换 src="./assets/xxx.png|jpg|jpeg" 形式的本地引用；
 * - 运行时资源（boot / wechat-qr）保持原格式不动；
 * - 已经是 .webp 的引用保持不变（幂等）。
 *
 * 使用方式：node apps/desktop/scripts/update-readme-image-refs.mjs [--dry-run]
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const desktopRoot = path.resolve(__dirname, '..')
const dryRun = process.argv.includes('--dry-run')

/** 运行时资源保持原格式（代码与打包流程按文件名引用） */
const KEEP_FORMAT = ['boot.jpg', 'boot_en.jpg', 'boot-start.png', 'wechat-qr.jpg']

const readmeFiles = ['README.md', 'README_EN.md']
const summary = []

for (const name of readmeFiles) {
  const filePath = path.join(desktopRoot, name)
  if (!fs.existsSync(filePath)) {
    console.warn(`[skip] 文件不存在: ${name}`)
    continue
  }

  const original = fs.readFileSync(filePath, 'utf8')
  let replaced = 0

  const updated = original.replace(/src="\.\/assets\/([^"]+)"/g, (match, asset) => {
    if (KEEP_FORMAT.includes(asset)) return match
    if (!/\.(png|jpe?g)$/i.test(asset)) return match
    replaced += 1
    return `src="./assets/${asset.replace(/\.(png|jpe?g)$/i, '.webp')}"`
  })

  if (!dryRun && replaced > 0) {
    fs.writeFileSync(filePath, updated, 'utf8')
  }
  summary.push({ file: name, replaced })
}

console.table(summary)
console.log(`[update-readme-image-refs] ${dryRun ? '预览模式，未写入。' : '引用已更新。'}`)
