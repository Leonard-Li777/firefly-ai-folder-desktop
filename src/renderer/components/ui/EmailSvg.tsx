import React from 'react'

interface EmailSvgProps {
  email?: string
  className?: string
  color?: string
  fontSize?: number
  fontWeight?: string
  underline?: boolean
}

/**
 * 邮件地址 SVG 防爬虫防护组件 (Desktop Electron 渲染进程)
 * 将邮箱地址转译为 Base64 SVG Image Data-URI，防止静态爬虫抓取。点击时唤起系统默认邮件客户端。
 */
export const EmailSvg: React.FC<EmailSvgProps> = ({
  email = 'support@aifolder.net',
  className = '',
  color = '#3b82f6',
  fontSize = 13,
  fontWeight = '600',
  underline = true
}) => {
  const width = Math.ceil(email.length * (fontSize * 0.65))
  const height = Math.ceil(fontSize * 1.4)
  const y = Math.ceil(fontSize * 1.05)

  const svgString = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><text x="0" y="${y}" fill="${color}" font-family="ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="${fontSize}" font-weight="${fontWeight}" ${underline ? 'text-decoration="underline"' : ''}>${email}</text></svg>`

  const base64Data = btoa(unescape(encodeURIComponent(svgString)))
  const dataUri = `data:image/svg+xml;base64,${base64Data}`

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault()
    window.open(`mailto:${email}`)
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      title="点击联系客服邮箱"
      className={`inline-flex items-center align-middle hover:opacity-80 transition-opacity cursor-pointer border-none bg-transparent p-0 ${className}`}
    >
      <img
        src={dataUri}
        alt="Support Email"
        className="inline-block align-middle pointer-events-none select-none"
        style={{ width: `${width}px`, height: `${height}px` }}
      />
    </button>
  )
}

export default EmailSvg
