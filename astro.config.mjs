// @ts-check
import { defineConfig } from 'astro/config';

// GitHub Pages serves the site from the repo sub-path.
const site = process.env.SITE_URL ?? 'https://bioassembly.github.io';
const base = process.env.BASE_PATH ?? '/sangeranalyst/';

export default defineConfig({
  site,
  base,
});
