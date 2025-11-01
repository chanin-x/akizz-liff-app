// svelte.config.js
import adapter from '@sveltejs/adapter-netlify';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // 
    adapter: adapter({
      // ใช้ Netlify Edge Functions เพื่อให้ API ตอบสนองเร็วที่สุด
      edge: true
    })
  }
};

export default config;