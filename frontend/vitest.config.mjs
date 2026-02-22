import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
    plugins: [react()],
    test: {
        environment: 'jsdom',
        setupFiles: ['./vitest.setup.js'],
        globals: true
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src')
        }
    },
    esbuild: {
        loader: 'jsx',
        include: /src\/.*\.[jt]sx?$/,
        exclude: [],
    }
})
