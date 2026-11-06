import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    react(),
    babel({
      presets: [
        reactCompilerPreset(),
        // Android 9 WebView is Chromium 66-70; chrome 69 is the safe floor
        ['@babel/preset-env', { targets: 'chrome 69' }],
      ],
      // Babel 8 removed useBuiltIns/corejs from preset-env; inject polyfills per usage instead
      plugins: [
        ['babel-plugin-polyfill-corejs3', { method: 'usage-global', version: '3.51' }],
      ],
    }),
  ],

  build: {
    target: ['chrome69'], // esbuild-style target; Android 9 WebView ≈ Chrome 69
    cssTarget: 'chrome61',
  },

  server: {
    host: '0.0.0.0',
    port: 3000,
    hmr: {
      host: '192.168.1.4',
      port: 3000,
      protocol: 'ws',
    },
    watch: {
      ignored: ['**/src-tauri/target/**', '**/src-tauri/gen/**', '**/src-tauri/target_check/**'],
    },
  },
})
