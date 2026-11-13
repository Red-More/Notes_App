import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { defineConfig } from 'vite'

// Tauri 真机 dev 时会注入正确内网IP；桌面端为空 → 回退 localhost
const host = process.env.TAURI_DEV_HOST || undefined

export default defineConfig({
  plugins: [
    react(),
    babel({
      presets: [reactCompilerPreset(), ['@babel/preset-env', { targets: 'chrome 69' }]],
      plugins: [['babel-plugin-polyfill-corejs3', { method: 'usage-global', version: '3.51' }]],
    }),
  ],

  build: {
    target: ['chrome69'],
    cssTarget: 'chrome61',
  },

  server: {
    port: 1420,
    strictPort: true, // ★ 被占就报错，绝不偷跳 3001
    host: host ? '0.0.0.0' : false, // ★ 真机绑全部网卡，桌面端只绑 localhost
    hmr: host
      ? { protocol: 'ws', host, port: 1421 } // ★ 用 Tauri 给的 IP，不再写死 192.168.1.4
      : undefined,
    watch: {
      ignored: ['**/src-tauri/target/**', '**/src-tauri/gen/**', '**/src-tauri/target_check/**'],
    },
  },
})
