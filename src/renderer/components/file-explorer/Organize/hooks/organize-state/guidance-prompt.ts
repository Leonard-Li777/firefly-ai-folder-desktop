import { t } from '@app/languages'

export const getDefaultGuidancePrompt = () =>
  t(`以设计师视角，按以下目录结构整理素材文件：

- 设计素材库
  - UI设计
    - 组件库
    - 页面模板
    - 图标素材
  - 插画素材
    - 扁平插画
    - 3D插画
    - 手绘风格
  - 字体资源
    - 中文字体
    - 英文字体
    - 特殊字体
  - 图片素材
    - 背景图片
    - 照片素材
    - 纹理贴图
  - 动效资源
    - Lottie动画
    - GIF动图
    - 视频素材`)
