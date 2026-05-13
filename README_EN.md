# Yonuc AI Folder - Smart File Manager

<p align="center">
  <a href="README.md">中文</a> | <b>English</b>
</p>

<p align="center">
  <img src="./assets/icon.png" width="128" alt="Yonuc Logo">
</p>

<p align="center">
  <strong>AI-Powered Intelligent File Management — Redefining Your Local File Organization</strong>
</p>

<p align="center">
  <a href="../../LICENSE">
    <img src="https://img.shields.io/badge/license-CC%20BY--NC--SA%204.0-blue.svg" alt="License">
  </a>
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-green.svg" alt="Platform">
  <img src="https://img.shields.io/badge/Status-Free-orange.svg" alt="Free">
</p>

---

## 🌟 Introduction

**Yonuc AI Folder** is an intelligent management tool powered by advanced AI technology. It deeply integrates local large language models to provide features like intelligent file analysis, virtual folder management, and one-key automatic organization.

Unlike traditional file managers, Yonuc brings AI understanding to your file system, transforming your files from cold data into knowledge assets with semantic meaning, quality scores, and multi-dimensional tags.

<p align="center">
  <img src="./assets/bootstrap.webp" width="100%" alt="Yonuc AI Folder App Screenshot">
</p>

---

## 📺 Demo Video

Click the preview image below to watch our demo on Bilibili and see how Yonuc transforms your file management experience:

<p align="center">
  <a href="https://www.bilibili.com/video/BV1gZAUzUEXe" target="_blank">
    <img src="./assets/onekeyOrganize.png" width="100%" alt="Yonuc AI Folder Demo Video">
  </a>
</p>

---

## ✨ Core Features

### 🧠 AI Intelligent Analysis
Utilize advanced AI technology to analyze and understand your data, supporting multiple media types including text, images, and video.

### 📁 Virtual Folder
Organize files personalizedly without consuming extra space using file linking technology.

### ⚡ One-key Organize
Quickly and accurately classify files and simplify management with AI-driven intelligent classification algorithms.

### ⚙️ Custom Organization
Rich directory tree tags help you customize file organization with a flexible tag system and dimension management.

### 🛡️ Privacy & Security
Local processing with no data uploaded to the cloud. Offline AI processing keeps your data completely local.

### ⭐ Quality Scoring
Score file quality through intelligent analysis to help quickly identify high-quality files.

---

## 🖼️ App Display

### 🔍 Real Directory Management
Select any files to organize; supports file addition, deletion, sniffing, and automatic analysis.
<p align="center">
  <img src="./assets/realDirectory.webp" width="90%" alt="Real Directory Management">
</p>

### 🗂️ Directory Management Modes
Supports both Speed Mode and Private Mode to meet your different needs.
<p align="center">
  <img src="./assets/workspace.png" width="90%" alt="Directory Management Modes">
</p>

### 📂 Virtual Directory Management
Browse AI analysis results and customize your directory structure without occupying file space.
<p align="center">
  <img src="./assets/virtualDirectory.webp" width="90%" alt="Virtual Directory Management">
</p>

### 🤖 Dual-mode AI Support
Supports both local and cloud modes, balancing privacy and efficiency.
<p align="center">
  <img src="./assets/modelsMode.png" width="90%" alt="Dual-mode AI Support">
</p>

### 📝 Organize Preview
One-click organization with preview support for peace of mind.
<p align="center">
  <img src="./assets/onekeyPreview.webp" width="90%" alt="Organize Preview">
</p>

### 💡 Local Model Recommendations
Recommended list of local AI models based on your machine's performance.
<p align="center">
  <img src="./assets/localModel.png" width="90%" alt="Local Model Recommendations">
</p>

### 🚀 Batch Processing
Batch processing organization, no worries even with many files.
<p align="center">
  <img src="./assets/bulkOrganize.webp" width="90%" alt="Batch Processing">
</p>

### 🌐 Internationalization Support
Complete internationalization support with 10 built-in languages.
<p align="center">
  <img src="./assets/i18n.png" width="90%" alt="Internationalization Support">
</p>

---

## 🚀 Application Advantages

### 🛠️ Technical Advantages
- **Advanced AI**: Integrates latest AI models, supporting multimodal (text/image/audio) analysis.
- **Cross-platform**: Supports Windows, macOS, and Linux.
- **High Performance**: Optimized indexing algorithms and GPU hardware acceleration support.
- **Offline First**: Complete core analysis without internet connection for lightning-fast response.
- **Cloud Caching**: Utilize cloud caching to accelerate analysis while maintaining efficiency.

### 💎 Functional Advantages
- **Smart Classification**: AI-driven automatic classification and tag generation.
- **Efficient Management**: Virtual folder technology allows "one file in multiple places" without extra storage.
- **Multi-dimensional Search**: Fast location via content summary, tags, scores, and more.
- **One-click Operations**: Simplify complex workflows to enhance productivity.

### 🌈 User Experience Advantages
- **Intuitive Interface**: Modern UI design complying with desktop system standards.
- **Smooth Operation**: Optimized performance for fluid user interaction.
- **Globalization**: Complete support for 10 languages for barrier-free international use.

---

## 🛠️ Technical Architecture

- **Core Framework**: [Electron](https://www.electronjs.org/) + [Electron Vite](https://electron-vite.org/)
- **Frontend**: React 19 + TypeScript + Tailwind CSS + Zustand
- **AI Engine**: [llama.cpp](https://github.com/ggml-org/llama.cpp) + LlamaIndex (Local Inference)
- **Database**: [Better-SQLite3](https://github.com/WiseLibs/better-sqlite3)
- **Native Deps**: ffmpeg, sharp, textract, libreoffice-convert
- **Internationalization**: VoerkaI18n (Source-as-copy mode)

---

## 📦 Build Instructions

If you need to build it yourself:

### Prerequisites
- **Node.js**: v22+
- **pnpm**: Recommended
- **llama.cpp**: Local AI reasoning environment

### Build Steps
```bash
# Install dependencies
pnpm install

# Start development server
pnpm dev

# Package the application
pnpm build
pnpm package
```
---

## 📬 Contact Us

- **Official Website**: [https://aifolder.iocn.cn](https://aifolder.iocn.cn)

<p>
  <img src="./assets/wechat-qr.jpg" width="200" alt="WeChat">

  <img src="./assets/feedback.jpg" width="200" alt="Feedback">
</p>
