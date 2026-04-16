# Yonuc AI Folder (Desktop App)

[中文版](README.md) | **English**

**Smart Virtual File Management Tool** is an AI-based file management system designed to solve problems such as scattered files, chaotic naming, and difficulties in multi-dimensional classification. This tool specifically targets the management of compressed files (such as comic archives), providing intelligent classification, password management, multi-dimensional viewing, and one-click organization functions.

## ✨ Core Features

*   **AI Intelligent Classification**: Integrated with Ollama local large models to automatically analyze file content and perform intelligent classification.
*   **Virtual Directory System**: Manage files multi-dimensionally through virtual directories without changing physical file locations.
*   **[TODO] Archive Management**: Deep support for ZIP/RAR and other compression formats, supporting password management and content preview.
*   **Multi-language Support**: Built-in multi-language system (VoerkaI18n), supporting Chinese, English, Japanese, etc.
*   **File System Monitoring**: Real-time monitoring of file changes to keep virtual directories synchronized with physical files.
*   **Local First**: All data and AI processing run locally to protect user privacy.

## 🛠 Tech Stack

*   **Core**: [Electron](https://www.electronjs.org/), [Electron Vite](https://electron-vite.org/)
*   **Frontend**: [React](https://react.dev/), [TypeScript](https://www.typescriptlang.org/), [Tailwind CSS](https://tailwindcss.com/)
*   **UI Components**: [Radix UI](https://www.radix-ui.com/)
*   **Database**: [Better-SQLite3](https://github.com/WiseLibs/better-sqlite3), [Supabase](https://supabase.com/) (Sync)
*   **AI Integration**: [Ollama](https://ollama.com/), LlamaIndex
*   **I18n**: [VoerkaI18n](https://github.com/voerkai18n/voerkai18n)

## 🚀 Quick Start

### Prerequisites

*   Node.js (Recommended v18+)
*   pnpm (Package Manager)
*   [Ollama](https://ollama.com/) (For AI functionality support)

### Install Dependencies

```bash
pnpm install
```

### Run in Development Environment

Start the development server (including main process and renderer process):

```bash
pnpm dev
```

#### Other Startup Modes

*   **AI Service Only**: `pnpm start:ai-only` (Only start AI-related logs and services)
*   **Analysis Mode**: `pnpm start:analysis` (Focus on file analysis and queue logs)
*   **Debug Mode**: `pnpm start:debug` (Enable detailed logs)
*   **Quiet Mode**: `pnpm start:quiet` (Only show error logs)

### Build and Package

Build production version:

```bash
pnpm build
```

Package the application (generate installer):

```bash
pnpm package
```

Generate installer:

```bash
pnpm make
```

## 📂 Project Structure

```
apps/desktop/
├── src/
│   ├── electron/          # Electron main process code
│   │   ├── adapters/      # Adapter layer
│   │   ├── config/        # Configuration management
│   │   ├── runtime-services/ # Runtime services (AI, Database, Filesystem, etc.)
│   │   └── main.ts        # Main process entry
│   ├── renderer/          # React renderer process code (UI)
│   ├── languages/         # Internationalization translation files
│   └── shared/            # Shared types and utilities between frontend and backend
├── scripts/               # Build and maintenance scripts
├── build/                 # Build resources (icons, extra config, etc.)
└── electron.vite.config.mts # Electron-Vite configuration file
```

Ensure Ollama is installed and the required models (such as `qwen3`, etc., refer to the configuration file for details) are downloaded.

## 📞 Contact

*   Author Email: seaeye777@qq.com

## 📄 License

[CC BY-NC-SA 4.0 License](LICENSE)
