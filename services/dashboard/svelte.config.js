import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter({
			pages: 'build',
			assets: 'build',
			fallback: 'index.html',
			precompress: false,
			strict: false
		}),
		alias: {
			$lib: './src/lib',
			// The frontend library extension pages build against (components,
			// utils, sanitize). The dashboard renders the same widgets, so it
			// imports them from the one copy instead of keeping its own.
			$shared: '../kernel/assets/extensions/_shared'
		},
		typescript: {
			// $shared sits outside this package, where TypeScript finds no
			// node_modules for its bare imports. Point them at ours (types only;
			// vite.config.ts `resolve.dedupe` does the same for the bundle).
			config(tsconfig) {
				tsconfig.compilerOptions.paths = {
					...tsconfig.compilerOptions.paths,
					dompurify: ['../node_modules/dompurify']
				};
			}
		}
	}
};

export default config;
