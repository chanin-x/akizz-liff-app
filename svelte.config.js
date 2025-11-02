// svelte.config.js
import adapter from '@sveltejs/adapter-netlify';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      // ❌ อย่าใช้ edge สำหรับ LINE webhook
      edge: false
    })
  }
};

export default config;
