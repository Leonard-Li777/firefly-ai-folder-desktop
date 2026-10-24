/**
 * 生成 AC7 搜索回归夹具（确定性合成，可重复运行）。
 *
 * 用法：node scripts/generate-search-regression-fixtures.mjs
 *
 * 产出（写入 src/electron/runtime-services/filesystem/virtual-directory-service/__fixtures__/search-regression/）：
 * - queries.json       10 条文档 query
 * - documents.json     10 篇基准文档清单
 * - lnk-negatives.json 66 条 .lnk 元数据快照（仅 name/rawName/description/content/ocr）
 *
 * 硬约束（AC7）：
 * - **不含用户绝对路径与 .lnk 二进制**：只有从资源管理器/Shell 属性页可公开读取的元数据；
 * - **确定性**：同一输入永远产出同一字节（禁止 Math.random / Date.now / 遍历顺序不稳定）；
 * - **待真实数据替换**：本仓库无现成真实快照（见 docs/adr/0039 附录 B 的测量记录），
 *   合成夹具仅用于固定测试规模与口径；真实快照就位后必须整体替换并重跑标定。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.resolve(
  __dirname,
  '../src/electron/runtime-services/filesystem/virtual-directory-service/__fixtures__/search-regression'
)

/** 10 条文档 query（AC7：与 10 篇基准文档一一对应的检索意图） */
const QUERIES = [
  '向量检索架构评审纪要',
  'EmbeddingGemma 双档位迁移方案',
  'zvec 编码器身份契约',
  '语义文本构建公式',
  '混合检索 RRF 权重调优',
  'MRL 维度 256 512 768 选择依据',
  'CLIP 文本塔以文搜图',
  '聚类 HAC 输入一致性',
  '整理归类消费 canonical 向量',
  '搜索回归负样本治理'
]

/**
 * 10 篇基准文档（AC7：MRR 的 ground truth）。
 * `relevantQueries` 标注每篇文档应对哪几条 query 命中（用于 MRR 计算）。
 */
const DOCUMENTS = [
  {
    id: 'doc-01',
    title: '向量检索架构评审纪要',
    fileName: '向量检索架构评审纪要.pdf',
    bodyKeywords: ['向量检索', '架构评审', '决议', '行动项'],
    relevantQueries: ['向量检索架构评审纪要', '混合检索 RRF 权重调优']
  },
  {
    id: 'doc-02',
    title: 'EmbeddingGemma 双档位迁移方案',
    fileName: 'EmbeddingGemma 双档位迁移方案.docx',
    bodyKeywords: ['EmbeddingGemma', 'classic_light', 'gemma_unified', '迁移'],
    relevantQueries: ['EmbeddingGemma 双档位迁移方案', 'MRL 维度 256 512 768 选择依据']
  },
  {
    id: 'doc-03',
    title: 'zvec 编码器身份契约',
    fileName: 'zvec 编码器身份契约.md',
    bodyKeywords: ['zvec', 'encoder_id', 'v3', '白名单'],
    relevantQueries: ['zvec 编码器身份契约']
  },
  {
    id: 'doc-04',
    title: '语义文本构建公式',
    fileName: '语义文本构建公式.md',
    bodyKeywords: ['buildSemanticText', '码点', '裁剪顺序', '版本号'],
    relevantQueries: ['语义文本构建公式']
  },
  {
    id: 'doc-05',
    title: '混合检索 RRF 权重调优',
    fileName: '混合检索 RRF 权重调优.md',
    bodyKeywords: ['RRF', '权重', 'fts', 'vec', 'name'],
    relevantQueries: ['混合检索 RRF 权重调优', '向量检索架构评审纪要']
  },
  {
    id: 'doc-06',
    title: 'MRL 维度选择依据',
    fileName: 'MRL 维度选择依据.md',
    bodyKeywords: ['MRL', '256', '512', '768', '召回'],
    relevantQueries: ['MRL 维度 256 512 768 选择依据']
  },
  {
    id: 'doc-07',
    title: 'CLIP 文本塔以文搜图',
    fileName: 'CLIP 文本塔以文搜图.md',
    bodyKeywords: ['CLIP', 'text_embeds', '以文搜图', '512'],
    relevantQueries: ['CLIP 文本塔以文搜图']
  },
  {
    id: 'doc-08',
    title: '聚类 HAC 输入一致性',
    fileName: '聚类 HAC 输入一致性.md',
    bodyKeywords: ['HAC', '聚类', '维度一致', 'JIT'],
    relevantQueries: ['聚类 HAC 输入一致性']
  },
  {
    id: 'doc-09',
    title: '整理归类消费 canonical 向量',
    fileName: '整理归类消费 canonical 向量.md',
    bodyKeywords: ['整理归类', 'canonical', 'zvec', 'JIT'],
    relevantQueries: ['整理归类消费 canonical 向量']
  },
  {
    id: 'doc-10',
    title: '搜索回归负样本治理',
    fileName: '搜索回归负样本治理.md',
    bodyKeywords: ['负样本', 'lnk', '阈值', 'vecScore'],
    relevantQueries: ['搜索回归负样本治理', '混合检索 RRF 权重调优']
  }
]

/**
 * 66 条 .lnk 元数据快照（AC7 规模硬门槛）。
 *
 * 选取原则：覆盖「通用工具名 / 系统目录 / 品牌软件 / 游戏平台」四类最常见的
 * 桌面快捷方式——它们在旧 ONNX 均值池化空间对泛化 query（如"跑车"）余弦被抬到
 * 0.58 以上，是最典型的假阳性来源（docs/adr/0039 附录 B）。
 *
 * 字段口径（仅 Shell 属性页公开元数据，**不含绝对路径与二进制**）：
 * - name      资源管理器显示名（含 .lnk 扩展名）
 * - rawName   文件名去掉命名骨架后的裸名（stripNamingSkeleton 口径）
 * - description 快捷方式备注（Shell 属性页"备注"字段）
 * - content   快捷方式目标描述文本（无正文；.lnk 不是文档）
 * - ocr       缩略图 OCR（本环境无缩略图，统一空串）
 */
const LNK_NEGATIVE_TEMPLATES = [
  // 通用工具（18）
  ['Visual Studio Code', 'VS Code 代码编辑器'],
  ['Sublime Text', '轻量文本编辑器'],
  ['Notepad++', '记事本增强'],
  ['Typora', 'Markdown 编辑器'],
  ['Xshell', '终端模拟器'],
  ['Xftp', '文件传输工具'],
  ['Everything', '文件名秒搜'],
  ['Snipaste', '截图贴图'],
  ['PicGo', '图床工具'],
  ['Postman', '接口调试'],
  ['DBeaver', '数据库客户端'],
  ['Navicat Premium', '数据库管理'],
  ['RedisDesktopManager', 'Redis 客户端'],
  ['Another Redis Desktop Manager', 'Redis 客户端'],
  ['FinalShell', 'SSH 工具'],
  ['MobaXterm', '远程计算工具'],
  ['WinSCP', 'SFTP 客户端'],
  ['Bandizip', '压缩解压'],
  // 系统目录（16）
  ['此电脑', '系统文件夹'],
  ['回收站', '系统文件夹'],
  ['控制面板', '系统设置'],
  ['用户文件夹', '系统文件夹'],
  ['下载', '系统文件夹'],
  ['文档', '系统文件夹'],
  ['图片', '系统文件夹'],
  ['音乐', '系统文件夹'],
  ['视频', '系统文件夹'],
  ['桌面', '系统文件夹'],
  ['网络', '系统文件夹'],
  ['管理工具', '系统文件夹'],
  ['命令提示符', '系统工具'],
  ['Windows PowerShell', '系统工具'],
  ['任务管理器', '系统工具'],
  ['注册表编辑器', '系统工具'],
  // 品牌软件（16）
  ['微信', '即时通讯'],
  ['企业微信', '企业即时通讯'],
  ['QQ', '即时通讯'],
  ['钉钉', '协同办公'],
  ['飞书', '协同办公'],
  ['腾讯会议', '视频会议'],
  ['Zoom', '视频会议'],
  ['Chrome', '浏览器'],
  ['Edge', '浏览器'],
  ['Firefox', '浏览器'],
  ['Steam', '游戏平台'],
  ['Epic Games Launcher', '游戏平台'],
  ['Battle.net', '游戏平台'],
  ['WeGame', '游戏平台'],
  ['网易云音乐', '音乐播放器'],
  ['PotPlayer', '视频播放器'],
  // 办公与效率（16）
  ['Word', '文字处理'],
  ['Excel', '电子表格'],
  ['PowerPoint', '演示文稿'],
  ['Outlook', '邮件客户端'],
  ['OneNote', '笔记'],
  ['Access', '数据库'],
  ['Project', '项目管理'],
  ['Visio', '图表绘制'],
  ['WPS 文字', '文字处理'],
  ['WPS 表格', '电子表格'],
  ['WPS 演示', '演示文稿'],
  ['Adobe Acrobat', 'PDF 阅读器'],
  ['Adobe Photoshop', '图像处理'],
  ['Adobe Illustrator', '矢量绘图'],
  ['Adobe Premiere Pro', '视频剪辑'],
  ['Foxit PDF Reader', 'PDF 阅读器']
]

function buildLnkNegatives() {
  if (LNK_NEGATIVE_TEMPLATES.length !== 66) {
    throw new Error(`AC7 要求 66 条负样本，当前模板 ${LNK_NEGATIVE_TEMPLATES.length} 条`)
  }
  return LNK_NEGATIVE_TEMPLATES.map(([name, description], index) => ({
    id: `lnk-neg-${String(index + 1).padStart(2, '0')}`,
    name: `${name}.lnk`,
    rawName: name,
    description,
    content: '',
    ocr: ''
  }))
}

function writeJson(fileName, data) {
  const target = path.join(OUT_DIR, fileName)
  // 稳定键序 + 2 空格缩进 + 末尾换行：保证同一输入产出同一字节
  fs.writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  const bytes = fs.statSync(target).size
  console.log(`${fileName}: ${Array.isArray(data) ? data.length : Object.keys(data).length} 条, ${bytes} bytes`)
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  writeJson('queries.json', QUERIES)
  writeJson('documents.json', DOCUMENTS)
  writeJson('lnk-negatives.json', buildLnkNegatives())
  console.log(`\n夹具目录: ${OUT_DIR}`)
  console.log('注意：合成夹具，待真实快照替换（见文件头注释与 calibration.json）。')
}

main()
