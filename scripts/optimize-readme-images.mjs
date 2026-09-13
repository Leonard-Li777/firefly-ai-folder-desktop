/**
 * desktop README 文档图片 WebP 化脚本
 *
 * 背景：README.md / README_EN.md 引用的截图合计约 7.7 MB，
 *       是仓库克隆与页面加载的主要体积来源。转为 WebP 后可显著瘦身。
 *
 * 严格边界（重要）：
 * 1. 只处理「README 引用 且 属于纯文档素材」的图片；
 * 2. 绝不触碰运行时资源：boot.jpg / boot_en.jpg（主进程闪屏 + forge loading）、
 *    wechat-qr.jpg（微信二维码）、icon.ico / icon.icns / logo.gif（系统图标格式强制）；
 * 3. 转换成功后删除被替换的原始位图（README 引用已同步指向 .webp）；
 * 4. 保持原始分辨率，quality 88，与营销站策略保持一致。
 *
 * 使用方式（monorepo 根目录执行）：
 *   node apps/desktop/scripts/optimize-readme-images.mjs --dry-run  # 预览
 *   node apps/desktop/scripts/optimize-readme-images.mjs            # 执行转换
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const require = createRequire(path.resolve(__dirname, '../../../package.json'))
const sharp = require('sharp')

const assetsDir = path.resolve(__dirname, '../assets')
const dryRun = process.argv.includes('--dry-run')

/** README 文档素材白名单（仅这些允许转换并删除原图） */
const DOC_IMAGES = [
  'aiEngine.png',
  'bulkOrganize.png',
  'export.png',
  'feature-platform.png',
  'feature-preview.png',
  'feature-privacy.png',
  'feature-quality.png',
  'feature-rename.png',
  'feature-search.png',
  'feature-tagging.png',
  'feature-virtual-dir.png',
  'feedback.jpg',
  'icon.png',
  'modelsMode.png',
  'onekeyOrganize.png',
  'realDirectory.jpg',
  'strategy.png',
  'virtualDirectory.png',
  'workspace.png'
]

/** 运行时资源黑名单：即使体积大也绝不转换（代码/打包流程按文件名引用） */
const RUNTIME_ASSETS = ['boot.jpg', 'boot_en.jpg', 'boot-start.png', 'wechat-qr.jpg']

const formatKb = bytes => `${(bytes / 1024).toFixed(1)} KiB`

async function run() {
  const results = []
  let originalTotal = 0
  let optimizedTotal = 0

  for (const file of DOC_IMAGES) {
    if (RUNTIME_ASSETS.includes(file)) {
      console.warn(`[skip] 运行时资源受保护: ${file}`)
      continue
    }

    const inputPath = path.join(assetsDir, file)
    if (!fs.existsSync(inputPath)) {
      console.warn(`[skip] 源文件不存在: ${file}`)
      continue
    }

    const outputName = `${path.parse(file).name}.webp`
    const outputPath = path.join(assetsDir, outputName)
    const originalSize = fs.statSync(inputPath).size
    const meta = await sharp(inputPath).metadata()

    const buffer = await sharp(inputPath).webp({ quality: 88, effort: 6 }).toBuffer()

    originalTotal += originalSize
    optimizedTotal += buffer.length
    results.push({
      file,
      output: outputName,
      resolution: `${meta.width}x${meta.height}`,
      from: formatKb(originalSize),
      to: formatKb(buffer.length),
      saved: `${(100 - (buffer.length / originalSize) * 100).toFixed(0)}%`
    })

    if (!dryRun) {
      fs.writeFileSync(outputPath, buffer)
      // 转换成功后删除被替换的原始位图（README 引用已同步更新）
      fs.unlinkSync(inputPath)
    }
  }

  console.table(results)
  console.log(
    `[optimize-readme-images] ${dryRun ? '预览模式，未写入/删除文件。' : '已生成 WebP 并移除被替换的原图。'} ` +
      `合计 ${formatKb(originalTotal)} → ${formatKb(optimizedTotal)}，` +
      `节省 ${(100 - (optimizedTotal / originalTotal) * 100).toFixed(0)}%`
  )
}

run().catch(error => {
  console.error('[optimize-readme-images] 处理失败:', error)
  process.exit(1)
})
