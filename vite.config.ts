import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  server: {
    host: '0.0.0.0', // 监听所有网络接口，允许手机访问
    port: 3000,
    hmr: {
      host: '192.168.1.4', // 电脑的局域网 IP，手机上的 WebSocket 会连接这个地址
      port: 3000,
      protocol: 'ws', // 明确使用 ws:// 协议
    },
    watch: {
      ignored: ['**/src-tauri/target/**', '**/src-tauri/gen/**', '**/src-tauri/target_check/**'],
    },
  },
})
