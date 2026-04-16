import { defineConfig } from 'vitest/config'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import react from '@vitejs/plugin-react'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test-setup.ts'],
    coverage: {
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'tests/e2e/',
        'tests/integration/',
        'src/shared/types/'
      ]
    }
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@/shared': resolve(__dirname, 'src/shared'),
      '@/electron': resolve(__dirname, 'src/electron'),
      '@/renderer': resolve(__dirname, 'src/renderer'),
      '@yonuc/types': resolve(__dirname, '../../packages/types/src'),
      '@yonuc/shared': resolve(__dirname, '../../packages/shared/src'),
      '@yonuc/core-engine': resolve(__dirname, '../../packages/core-engine/src'),
      '@yonuc/server': resolve(__dirname, '../server/src'),
      '@yonuc/electron-llamaIndex-service': resolve(__dirname, '../../packages/electron-llamaIndex-service/src'),
      '@app/languages': resolve(__dirname, 'src/languages'),
      'electron': resolve(__dirname, 'src/test-setup.ts')
    }
  }
})