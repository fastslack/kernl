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
		// Loopback, like the nginx dashboard the compose file publishes on
		// `127.0.0.1:3086` ("loopback only; the API behind it requires a token").
		// `host: true` used to be the default here, which quietly undid that: the
		// dev server answered on every interface and its `/api` proxy handed the
		// whole LAN a route to a kernel that was deliberately bound to loopback.
		//
		// The Docker case is unaffected — `dashboard-dev` in docker-compose.full.yml
		// passes `--host 0.0.0.0` on the command line, and publishes on 127.0.0.1
		// as well. Set VITE_DEV_HOST to override for anything else (a VM, a phone
		// on the same wifi), so opening it up is a decision someone makes on purpose.
		host: process.env.VITE_DEV_HOST ?? '127.0.0.1',
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
