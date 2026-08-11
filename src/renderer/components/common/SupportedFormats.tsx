import React from 'react'
import { t } from '@app/languages'
import { MaterialIcon } from '../../lib/utils'

const SUPPORTED_FORMATS = {
  native: {
    label: '原生预览',
    hint: '即时渲染',
    icon: 'check_circle',
    iconColor: 'text-green-500',
    categories: [
      {
        name: '图片',
        formats: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico']
      },
      {
        name: '音频',
        formats: ['mp3', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'flac', 'weba']
      },
      {
        name: '视频',
        formats: ['mp4', 'webm']
      },
      {
        name: '纯文本',
        formats: ['txt', 'log', 'bat', 'cmd', 'ps1', 'toml', 'gitignore']
      }
    ]
  },
  flyfish: {
    label: '高级预览',
    hint: '复杂渲染',
    icon: 'check_circle',
    iconColor: 'text-blue-500',
    categories: [
      {
        name: '文档',
        formats: [
          'pdf',
          'docx',
          'doc',
          'docm',
          'dotx',
          'dotm',
          'dot',
          'xlsx',
          'xls',
          'xlsm',
          'xlsb',
          'xltx',
          'xlt',
          'xltm',
          'csv',
          'pptx',
          'pptm',
          'potx',
          'potm',
          'ppsx',
          'ppsm',
          'odt',
          'ods',
          'odp',
          'fods',
          'numbers',
          'ofd',
          'rtf',
          'typ',
          'typst'
        ]
      },
      {
        name: '压缩包',
        formats: [
          'zip',
          'zipx',
          '7z',
          'rar',
          'tar',
          'gz',
          'gzip',
          'tgz',
          'bz2',
          'bzip2',
          'tbz',
          'tbz2',
          'xz',
          'txz',
          'lzma',
          'zst',
          'tzst',
          'cab',
          'ar',
          'cpio',
          'iso',
          'xar',
          'lha',
          'lzh',
          'jar',
          'war',
          'ear',
          'apk',
          'cbz',
          'cbr'
        ]
      },
      {
        name: '邮件',
        formats: ['eml', 'msg', 'mbox']
      },
      {
        name: 'CAD/EDA',
        formats: ['dwg', 'dxf', 'dwf', 'dwfx', 'xps', 'olb', 'dra', 'gds', 'oas', 'oasis']
      },
      {
        name: '3D 模型',
        formats: [
          'glb',
          'gltf',
          'obj',
          'stl',
          'ply',
          'fbx',
          'dae',
          '3ds',
          '3mf',
          'amf',
          'usd',
          'usda',
          'usdc',
          'usdz',
          'kmz',
          'pcd',
          'wrl',
          'vrml',
          'xyz',
          'vtk',
          'vtp',
          'step',
          'stp',
          'iges',
          'igs',
          'ifc',
          '3dm'
        ]
      },
      {
        name: '地理数据',
        formats: ['geojson', 'kml', 'gpx', 'shp']
      },
      {
        name: '脑图/绘图',
        formats: ['xmind', 'excalidraw', 'drawio', 'dio', 'mermaid', 'mmd', 'plantuml', 'puml']
      },
      {
        name: '电子书',
        formats: ['epub', 'umd']
      },
      {
        name: '标记语言',
        formats: [
          'md',
          'markdown',
          'json',
          'jsonc',
          'json5',
          'yaml',
          'yml',
          'xml',
          'toml',
          'ini',
          'proto',
          'hcl'
        ]
      },
      {
        name: '代码',
        formats: [
          'js',
          'mjs',
          'cjs',
          'ts',
          'tsx',
          'jsx',
          'css',
          'html',
          'htm',
          'vue',
          'react',
          'svelte',
          'java',
          'py',
          'go',
          'rs',
          'rb',
          'php',
          'c',
          'cpp',
          'cc',
          'h',
          'hpp',
          'cs',
          'swift',
          'kt',
          'sh',
          'bash',
          'sql',
          'graphql',
          'dart',
          'lua',
          'pl',
          'pm',
          'r',
          'ipynb'
        ]
      },
      {
        name: '设计/字体/数据',
        formats: [
          'psd',
          'ai',
          'eps',
          'ttf',
          'otf',
          'woff',
          'woff2',
          'sqlite',
          'wasm',
          'parquet',
          'avro',
          'webarchive'
        ]
      },
      {
        name: '图片/音视频扩展',
        formats: ['tiff', 'tif', 'heic', 'heif', 'avif', 'jxl', 'midi', 'mid', 'm3u8']
      },
      {
        name: 'Git/Source',
        formats: ['diff', 'patch', 'bundle', 'bdl', 'tex', 'gv', 'http']
      }
    ]
  }
}

interface SupportedFormatsProps {
  mode?: 'full' | 'compact'
  className?: string
}

export const SupportedFormats: React.FC<SupportedFormatsProps> = ({
  mode = 'full',
  className = ''
}) => {
  if (mode === 'compact') {
    return (
      <div className={`space-y-2 ${className}`}>
        <p className="text-[11px] text-muted-foreground/70">
          {t('支持的格式')}：
          <span className="text-muted-foreground/50">
            {[
              ...SUPPORTED_FORMATS.native.categories.flatMap(c => c.formats.slice(0, 2)),
              '...'
            ].join(', ')}
          </span>
        </p>
      </div>
    )
  }

  return (
    <div className={`space-y-4 ${className}`}>
      <p className="text-xs font-medium text-center text-muted-foreground/80 border-t border-border/50 pt-4">
        {t('支持 206 种预览格式')}
      </p>

      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          <MaterialIcon
            icon={SUPPORTED_FORMATS.native.icon}
            className={`text-xs ${SUPPORTED_FORMATS.native.iconColor}`}
          />
          <span className="text-xs font-medium">{t(SUPPORTED_FORMATS.native.label)}</span>
          <span className="text-[10px] text-muted-foreground/60">
            ({t(SUPPORTED_FORMATS.native.hint)})
          </span>
        </div>
        <div className="grid grid-cols-1 gap-x-4 gap-y-1.5 pl-5">
          {SUPPORTED_FORMATS.native.categories.map(cat => (
            <div key={cat.name} className="text-[11px]">
              <span className="text-muted-foreground/80">{t(cat.name)}：</span>
              <span className="text-muted-foreground/60">{cat.formats.join(', ')} ...</span>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          <MaterialIcon
            icon={SUPPORTED_FORMATS.flyfish.icon}
            className={`text-xs ${SUPPORTED_FORMATS.flyfish.iconColor}`}
          />
          <span className="text-xs font-medium">{t(SUPPORTED_FORMATS.flyfish.label)}</span>
          <span className="text-[10px] text-muted-foreground/60">
            ({t(SUPPORTED_FORMATS.flyfish.hint)})
          </span>
        </div>
        <div className="grid grid-cols-1 gap-x-4 gap-y-1.5 pl-5">
          {SUPPORTED_FORMATS.flyfish.categories.map(cat => (
            <div key={cat.name} className="text-[11px]">
              <span className="text-muted-foreground/80">{t(cat.name)}：</span>
              <span className="text-muted-foreground/60">{cat.formats.join(', ')} ...</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default SupportedFormats
