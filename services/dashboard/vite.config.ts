import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Targets for the dev-server proxy. Defaults assume vite running on the host
// (developer laptop). When running inside Docker (the `dashboard-dev`
// compose service), set these to the docker network names — for example:
//   VITE_PROXY_API=http://kernel:3087
//   VITE_PROXY_MTW=ws://mtw-request:7741
const API_TARGET = process.env.VITE_PROXY_API ?? 'http://localhost:3086';
const KERNEL_TARGET = process.env.VITE_PROXY_MTW ?? 'ws://localhost:7741';

export default defineConfig({
	plugins: [sveltekit()],
	server: {
		// Bind to 0.0.0.0 inside Docker so the host can reach the dev server.
		host: true,
		proxy: {
			'/api': API_TARGET,
			'/ext-assets': API_TARGET,
			'/mcp': API_TARGET,
			// WebSocket via mtwRequest (Rust)
			'/mtw': { target: KERNEL_TARGET, ws: true, rewrite: (path) => path.replace(/^\/mtw/, '/ws') }
		}
	},
	ssr: {
		noExternal: ['three']
	},
	optimizeDeps: {
		include: ['three']
	}
});
