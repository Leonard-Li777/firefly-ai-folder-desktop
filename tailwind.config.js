/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  // Tailwind v4 使用 CSS-first 配置，大部分配置已移到 index.css 的 @theme 中
  // 此文件保留用于兼容性
}