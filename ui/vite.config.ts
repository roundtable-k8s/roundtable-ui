import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
  build: {
    outDir: '../api/static',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (/node_modules\/(react|react-dom|react-router|react-router-dom|scheduler)\//.test(id)) return 'vendor-react'
          if (id.includes('@xyflow') || id.includes('d3-')) return 'vendor-flow'
          if (/node_modules\/(react-markdown|remark|rehype|mdast|hast|micromark|unified|unist|vfile|decode-named|character-entities|property-information|space-separated|comma-separated)/.test(id)) return 'vendor-markdown'
          return undefined
        },
      },
    },
  },
})
