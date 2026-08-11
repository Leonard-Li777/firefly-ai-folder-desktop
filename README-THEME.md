# 主题系统使用指南

## 概述

本项目使用 shadcn/ui + Tailwind CSS 构建的主题系统，支持：
- ✅ 明暗双色模式（Light/Dark/Auto）
- ✅ 6 种内置配色方案
- ✅ CSS 变量驱动，无需修改组件代码
- ✅ 主题和配色实时切换
- ✅ 设置持久化到 localStorage

## 配色方案

| 方案 | 标识 | 说明 | 适用场景 |
|------|------|------|----------|
| 经典蓝 | `blue` | 专业可靠的蓝色系 | 默认配色，适合办公应用 |
| 优雅紫 | `purple` | 高贵优雅的紫色系 | 创意类应用 |
| 自然绿 | `green` | 清新自然的绿色系 | 健康、环保类应用 |
| 活力橙 | `orange` | 充满活力的橙色系 | 社交、娱乐类应用 |
| 玫瑰红 | `rose` | 温暖浪漫的红色系 | 生活、情感类应用 |
| 中性灰 | `slate` | 低调专业的灰色系 | 极简风格应用 |

## 用户使用

### 切换主题模式

1. 点击应用右上角的「设置」图标
2. 进入「界面设置」分类
3. 在「主题模式」区域选择：
   - **浅色主题** - 始终使用浅色界面
   - **深色主题** - 始终使用深色界面
   - **跟随系统** - 根据系统设置自动切换

### 切换配色方案

1. 点击应用右上角的「设置」图标
2. 进入「界面设置」分类
3. 在「配色方案」区域点击想要的配色
4. 配色立即生效并自动保存

## 开发者使用

### 在组件中使用主题

```tsx
import { useTheme } from '@/components/theme-provider'

function MyComponent() {
  const { theme, colorScheme, setTheme, setColorScheme } = useTheme()
  
  return (
    <div>
      <p>当前主题: {theme}</p>
      <p>当前配色: {colorScheme}</p>
      
      <button onClick={() => setTheme('dark')}>
        切换到深色
      </button>
      
      <button onClick={() => setColorScheme('purple')}>
        切换到紫色
      </button>
    </div>
  )
}
```

### 使用 CSS 变量类名

推荐使用语义化的 CSS 变量类名：

```tsx
// ✅ 推荐：使用语义化类名
<div className="bg-background text-foreground">
  <div className="bg-card text-card-foreground border-border">
    <h1 className="text-primary">标题</h1>
    <p className="text-muted-foreground">描述文字</p>
    <button className="bg-primary text-primary-foreground hover:bg-primary/90">
      按钮
    </button>
  </div>
</div>

// ❌ 不推荐：硬编码颜色
<div className="bg-white text-black dark:bg-gray-900 dark:text-white">
  ...
</div>
```

### 使用 dark: 前缀

对于需要在暗色模式下特殊处理的样式：

```tsx
<div className="
  bg-background dark:bg-background
  border-border dark:border-border
  hover:bg-accent dark:hover:bg-accent
  shadow-sm dark:shadow-lg
">
  内容
</div>
```

### CSS 变量参考

所有可用的 CSS 变量：

| 变量名 | 用途 | 示例类名 |
|--------|------|----------|
| `--background` | 主背景色 | `bg-background` |
| `--foreground` | 主文字色 | `text-foreground` |
| `--card` | 卡片背景色 | `bg-card` |
| `--card-foreground` | 卡片文字色 | `text-card-foreground` |
| `--popover` | 弹窗背景色 | `bg-popover` |
| `--popover-foreground` | 弹窗文字色 | `text-popover-foreground` |
| `--primary` | 主色 | `bg-primary`, `text-primary` |
| `--primary-foreground` | 主色文字 | `text-primary-foreground` |
| `--secondary` | 次要色 | `bg-secondary` |
| `--secondary-foreground` | 次要色文字 | `text-secondary-foreground` |
| `--muted` | 静音背景色 | `bg-muted` |
| `--muted-foreground` | 静音文字色 | `text-muted-foreground` |
| `--accent` | 强调色 | `bg-accent` |
| `--accent-foreground` | 强调色文字 | `text-accent-foreground` |
| `--destructive` | 危险色 | `bg-destructive` |
| `--destructive-foreground` | 危险色文字 | `text-destructive-foreground` |
| `--border` | 边框色 | `border-border` |
| `--input` | 输入框边框色 | `border-input` |
| `--ring` | 聚焦环颜色 | `ring-ring` |

### shadcn 组件示例

```tsx
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

function Example() {
  return (
    <Card className="p-6">
      <DialogHeader>
        <DialogTitle>标题</DialogTitle>
      </DialogHeader>
      
      <div className="space-y-4">
        <Button variant="default">主要按钮</Button>
        <Button variant="secondary">次要按钮</Button>
        <Button variant="outline">轮廓按钮</Button>
        <Button variant="ghost">幽灵按钮</Button>
        <Button variant="destructive">危险按钮</Button>
      </div>
    </Card>
  )
}
```

## 添加新配色方案

1. 编辑 `src/renderer/lib/theme-config.ts`
2. 在 `colorSchemes` 对象中添加新方案：

```typescript
export const colorSchemes: Record<ColorScheme, ThemeColors> = {
  // ... 现有方案
  
  'your-scheme': {
    name: 'your-scheme',
    label: '你的方案名',
    cssVars: {
      light: {
        background: '0 0% 100%',
        foreground: '222 47% 11%',
        // ... 其他变量
      },
      dark: {
        background: '222 47% 11%',
        foreground: '210 40% 98%',
        // ... 其他变量
      }
    }
  }
}
```

3. 更新 `ColorScheme` 类型：

```typescript
export type ColorScheme = 'blue' | 'purple' | 'green' | 'orange' | 'rose' | 'slate' | 'your-scheme'
```

4. 在 `interface-settings.tsx` 中添加预览色块（可选）

## 最佳实践

### 1. 始终使用语义化类名
```tsx
// ✅ 正确
<div className="bg-card text-card-foreground border-border">

// ❌ 错误
<div className="bg-white text-black border-gray-200">
```

### 2. 避免使用 !important
```tsx
// ✅ 正确
<div className="bg-background dark:bg-background">

// ❌ 错误
<div className="bg-white dark:!bg-gray-900">
```

### 3. 使用 shadcn 组件
```tsx
// ✅ 正确：使用 shadcn Button
import { Button } from '@/components/ui/button'
<Button variant="default">点击</Button>

// ❌ 错误：自定义样式按钮
<button className="px-4 py-2 bg-blue-500 text-white rounded">
  点击
</button>
```

### 4. 测试所有主题
- 在浅色和深色模式下测试
- 在所有 6 种配色方案下测试
- 确保文字可读性和对比度

### 5. 保持一致性
- 使用相同的间距和圆角
- 使用相同的字体大小层级
- 使用相同的动画时长

## 故障排查

### 主题不生效

1. 检查 `ThemeProvider` 是否正确包裹应用
2. 检查 localStorage 中的主题设置
3. 清除浏览器缓存并重新加载

```typescript
// 检查当前主题
console.log(localStorage.getItem('vite-ui-theme'))
// 检查当前配色
console.log(localStorage.getItem('vite-ui-theme-color'))
```

### 颜色显示异常

1. 检查 CSS 变量是否正确应用：

```javascript
// 在浏览器控制台执行
const root = document.documentElement
const styles = getComputedStyle(root)
console.log(styles.getPropertyValue('--primary'))
```

2. 确保使用了正确的类名格式
3. 检查是否有冲突的全局样式

### 配色切换不流畅

1. 确保使用 CSS 变量而非硬编码颜色
2. 添加过渡动画：

```css
* {
  transition: background-color 0.2s ease, color 0.2s ease, border-color 0.2s ease;
}
```

## 相关文件

- `src/renderer/lib/theme-config.ts` - 配色方案定义
- `src/renderer/components/theme-provider.tsx` - 主题提供者
- `src/renderer/components/settings/interface-settings.tsx` - 主题设置界面
- `src/renderer/index.css` - 全局 CSS 变量定义
- `tailwind.config.js` - Tailwind 配置

## 更多资源

- [shadcn/ui 文档](https://ui.shadcn.com/)
- [Tailwind CSS 暗色模式](https://tailwindcss.com/docs/dark-mode)
- [CSS 变量使用指南](https://developer.mozilla.org/zh-CN/docs/Web/CSS/Using_CSS_custom_properties)
