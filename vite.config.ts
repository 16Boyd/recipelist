import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: false,
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/client/setup.ts'],
    include: ['tests/client/**/*.test.{ts,tsx}', 'tests/server/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    clearMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}', 'server/**/*.ts'],
      exclude: [
        'src/main.tsx',
        'src/types.ts',
        'src/vite-env.d.ts',
        'server/db.ts',
        'server/index.ts',
        'server/migrate.ts',
        'server/promote-admin.ts',
      ],
      reporter: ['text', 'html'],
    },
  },
})
