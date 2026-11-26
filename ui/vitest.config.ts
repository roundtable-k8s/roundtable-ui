import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    globalSetup: './src/test/global-setup.ts',
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    css: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    conditions: ['development'],
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('test'),
  },
})
