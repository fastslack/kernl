<script lang="ts">
	/**
	 * Add + manage remote filesystems (SFTP / S3 / WebDAV).
	 *
	 * Credentials are sent to the server, which encrypts them at rest
	 * (AES-256-GCM via FS_COMMANDER_KEY). Never stored in the browser.
	 */
	import { onMount } from 'svelte';
	import { createEventDispatcher } from 'svelte';

	export let onClose: () => void;

	const dispatch = createEventDispatcher<{
		added: { providerId: string };
		removed: { id: string };
	}>();

	type Kind = 'sftp' | 's3' | 'webdav';

	interface RemoteRow {
		id: string;
		kind: Kind;
		label: string;
		provider_id: string;
		created_at: string;
	}

	let remotes: RemoteRow[] = [];
	let loading = true;
	let error: string | null = null;
	let kind: Kind = 'sftp';
	let label = '';
	let submitting = false;

	// Form inputs (typed broad; we filter by kind before POST)
	let sftp = { host: '', port: 22, username: '', password: '', privateKey: '', passphrase: '' };
	let s3 = {
		region: 'us-east-1',
		accessKeyId: '',
		secretAccessKey: '',
		endpoint: '',
		bucket: '',
		forcePathStyle: false
	};
	let webdav = { baseUrl: '', username: '', password: '', token: '' };

	function authHeaders(): Record<string, string> {
		const h: Record<string, string> = {};
		if (typeof localStorage !== 'undefined') {
			const t = localStorage.getItem('kernel_auth_token');
			if (t) h['Authorization'] = `Bearer ${t}`;
		}
		return h;
	}

	async function loadRemotes(): Promise<void> {
		loading = true;
		try {
			const r = await fetch('/api/fs/remotes', { headers: authHeaders() });
			const data = (await r.json()) as { items: RemoteRow[] };
			remotes = data.items ?? [];
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	function buildConfig(): Record<string, unknown> {
		if (kind === 'sftp') {
			const cfg: Record<string, unknown> = {
				host: sftp.host.trim(),
				port: Number(sftp.port) || 22,
				username: sftp.username.trim()
			};
			if (sftp.password) cfg.password = sftp.password;
			if (sftp.privateKey) cfg.privateKey = sftp.privateKey;
			if (sftp.passphrase) cfg.passphrase = sftp.passphrase;
			return cfg;
		}
		if (kind === 's3') {
			const cfg: Record<string, unknown> = {
				region: s3.region.trim() || 'us-east-1',
				accessKeyId: s3.accessKeyId.trim(),
				secretAccessKey: s3.secretAccessKey,
				bucket: s3.bucket.trim()
			};
			if (s3.endpoint) cfg.endpoint = s3.endpoint.trim();
			if (s3.forcePathStyle) cfg.forcePathStyle = true;
			return cfg;
		}
		// webdav
		const cfg: Record<string, unknown> = { baseUrl: webdav.baseUrl.trim() };
		if (webdav.username) cfg.username = webdav.username;
		if (webdav.password) cfg.password = webdav.password;
		if (webdav.token) cfg.token = webdav.token;
		return cfg;
	}

	async function addRemote(): Promise<void> {
		submitting = true;
		error = null;
		try {
			const r = await fetch('/api/fs/remotes', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...authHeaders() },
				body: JSON.stringify({ kind, label: label.trim(), config: buildConfig() })
			});
			const data = (await r.json()) as { item?: { provider_id: string }; error?: string };
			if (!r.ok || !data.item) throw new Error(data.error ?? 'Failed');
			dispatch('added', { providerId: data.item.provider_id });
			label = '';
			resetForms();
			await loadRemotes();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			submitting = false;
		}
	}

	async function testRemote(id: string): Promise<void> {
		const r = await fetch(`/api/fs/remotes/${encodeURIComponent(id)}/test`, {
			method: 'POST',
			headers: authHeaders()
		});
		const data = (await r.json()) as { ok: boolean; error?: string };
		alert(data.ok ? '✓ Connected' : `✗ ${data.error ?? 'Failed'}`);
	}

	async function removeRemote(id: string): Promise<void> {
		if (!confirm('Remove this remote?')) return;
		await fetch(`/api/fs/remotes/${encodeURIComponent(id)}`, {
			method: 'DELETE',
			headers: authHeaders()
		});
		dispatch('removed', { id });
		await loadRemotes();
	}

	function resetForms(): void {
		sftp = { host: '', port: 22, username: '', password: '', privateKey: '', passphrase: '' };
		s3 = {
			region: 'us-east-1',
			accessKeyId: '',
			secretAccessKey: '',
			endpoint: '',
			bucket: '',
			forcePathStyle: false
		};
		webdav = { baseUrl: '', username: '', password: '', token: '' };
	}

	function onKey(ev: KeyboardEvent): void {
		if (ev.key === 'Escape') onClose();
	}

	$: canSubmit =
		label.trim().length > 0 &&
		(kind === 'sftp'
			? sftp.host.trim() && sftp.username.trim() && (sftp.password || sftp.privateKey)
			: kind === 's3'
				? s3.accessKeyId.trim() && s3.secretAccessKey && s3.bucket.trim()
				: webdav.baseUrl.trim().length > 0);

	onMount(() => {
		loadRemotes();
	});
</script>

<svelte:window on:keydown={onKey} />

<div class="rm-overlay" on:click|self={onClose} role="dialog" aria-modal="true">
	<div class="rm-dialog">
		<div class="rm-header">
			<span class="rm-title">REMOTE FILESYSTEMS</span>
			<button class="rm-close" on:click={onClose} aria-label="Close">×</button>
		</div>

		<div class="rm-body">
			<!-- Existing remotes -->
			<section class="rm-section">
				<h3>Configured</h3>
				{#if loading}
					<div class="rm-muted">Loading…</div>
				{:else if remotes.length === 0}
					<div class="rm-muted">No remotes yet.</div>
				{:else}
					<table class="rm-table">
						<thead>
							<tr>
								<th>Kind</th>
								<th>Label</th>
								<th>Provider ID</th>
								<th></th>
							</tr>
						</thead>
						<tbody>
							{#each remotes as r (r.id)}
								<tr>
									<td><span class="rm-kind rm-k-{r.kind}">{r.kind}</span></td>
									<td>{r.label}</td>
									<td><code>{r.provider_id}</code></td>
									<td class="rm-actions">
										<button on:click={() => testRemote(r.id)}>Test</button>
										<button class="rm-danger" on:click={() => removeRemote(r.id)}>Remove</button>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				{/if}
			</section>

			<!-- New remote form -->
			<section class="rm-section">
				<h3>Add new</h3>
				<div class="rm-row">
					<label>
						Kind
						<select bind:value={kind}>
							<option value="sftp">SFTP</option>
							<option value="s3">S3 (or compat)</option>
							<option value="webdav">WebDAV</option>
						</select>
					</label>
					<label>
						Label
						<input bind:value={label} placeholder="prod-server, backup-bucket, …" />
					</label>
				</div>

				{#if kind === 'sftp'}
					<div class="rm-grid">
						<label>Host <input bind:value={sftp.host} placeholder="example.com" /></label>
						<label>Port <input type="number" bind:value={sftp.port} /></label>
						<label>Username <input bind:value={sftp.username} /></label>
						<label>Password <input type="password" bind:value={sftp.password} /></label>
						<label class="wide">Private key (PEM) <textarea bind:value={sftp.privateKey} rows="3" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----…" /></label>
						<label>Passphrase <input type="password" bind:value={sftp.passphrase} /></label>
					</div>
				{:else if kind === 's3'}
					<div class="rm-grid">
						<label>Region <input bind:value={s3.region} /></label>
						<label>Bucket <input bind:value={s3.bucket} /></label>
						<label>Access Key ID <input bind:value={s3.accessKeyId} /></label>
						<label>Secret Access Key <input type="password" bind:value={s3.secretAccessKey} /></label>
						<label>Endpoint (optional, for MinIO/R2/B2) <input bind:value={s3.endpoint} placeholder="https://…" /></label>
						<label class="inline">
							<input type="checkbox" bind:checked={s3.forcePathStyle} />
							Force path-style
						</label>
					</div>
				{:else}
					<div class="rm-grid">
						<label class="wide">Base URL <input bind:value={webdav.baseUrl} placeholder="https://dav.example.com/remote.php/dav/files/user" /></label>
						<label>Username <input bind:value={webdav.username} /></label>
						<label>Password <input type="password" bind:value={webdav.password} /></label>
						<label class="wide">Bearer token (alt) <input type="password" bind:value={webdav.token} /></label>
					</div>
				{/if}

				{#if error}
					<div class="rm-error">⚠︎ {error}</div>
				{/if}

				<div class="rm-foot">
					<button disabled={!canSubmit || submitting} on:click={addRemote}>
						{submitting ? 'Adding…' : 'Add remote'}
					</button>
				</div>
			</section>
		</div>
	</div>
</div>

<style>
	.rm-overlay {
		position: fixed;
		inset: 0;
		background: color-mix(in srgb, #000 70%, transparent);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 970;
		backdrop-filter: blur(4px);
	}
	.rm-dialog {
		background: var(--surface-1);
		border: 1px solid var(--gold);
		border-radius: var(--radius);
		width: min(960px, 94vw);
		max-height: 92vh;
		overflow: hidden;
		display: grid;
		grid-template-rows: auto 1fr;
		box-shadow: 0 30px 80px color-mix(in srgb, var(--gold) 20%, #000);
		font-family: 'Fira Code', monospace;
	}
	.rm-header {
		display: flex;
		align-items: center;
		padding: 10px 16px;
		background: color-mix(in srgb, var(--gold) 8%, var(--surface-1));
		border-bottom: 1px solid var(--border);
		font-size: 12px;
	}
	.rm-title {
		color: var(--gold);
		font-weight: 700;
		letter-spacing: 0.1em;
	}
	.rm-close {
		margin-left: auto;
		background: none;
		border: none;
		color: var(--text-3);
		font-size: 20px;
		cursor: pointer;
	}
	.rm-close:hover {
		color: var(--red);
	}
	.rm-body {
		padding: 16px 20px;
		overflow: auto;
	}
	.rm-section {
		margin-bottom: 20px;
	}
	.rm-section h3 {
		font-size: 11px;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--gold);
		margin: 0 0 8px;
	}
	.rm-muted {
		color: var(--text-3);
		font-size: 12px;
	}
	.rm-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 12px;
	}
	.rm-table th {
		text-align: left;
		color: var(--text-2);
		border-bottom: 1px solid var(--border);
		padding: 4px 6px;
		font-weight: 600;
	}
	.rm-table td {
		padding: 6px;
		border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
		color: var(--text-1);
	}
	.rm-table code {
		color: var(--teal);
	}
	.rm-kind {
		display: inline-block;
		padding: 1px 6px;
		font-size: 10px;
		text-transform: uppercase;
		border-radius: 3px;
		background: var(--surface-2);
		color: var(--text-2);
	}
	.rm-k-sftp { color: var(--blue); background: color-mix(in srgb, var(--blue) 15%, transparent); }
	.rm-k-s3 { color: var(--orange); background: color-mix(in srgb, var(--orange) 15%, transparent); }
	.rm-k-webdav { color: var(--purple); background: color-mix(in srgb, var(--purple) 15%, transparent); }
	.rm-actions { text-align: right; }
	.rm-actions button {
		font-size: 11px;
		padding: 2px 8px;
		margin-left: 4px;
		background: var(--surface-2);
		border: 1px solid var(--border);
		color: var(--text-1);
		border-radius: 3px;
		cursor: pointer;
		font-family: inherit;
	}
	.rm-actions button:hover { border-color: var(--gold); color: var(--gold); }
	.rm-actions button.rm-danger:hover { border-color: var(--red); color: var(--red); }
	.rm-row, .rm-grid {
		display: grid;
		gap: 10px;
		margin-bottom: 10px;
	}
	.rm-row { grid-template-columns: 1fr 2fr; }
	.rm-grid { grid-template-columns: 1fr 1fr; }
	.rm-grid .wide { grid-column: 1 / -1; }
	.rm-body label {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 11px;
		color: var(--text-2);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.rm-body label.inline {
		flex-direction: row;
		align-items: center;
		gap: 6px;
	}
	.rm-body input,
	.rm-body select,
	.rm-body textarea {
		background: var(--bg);
		border: 1px solid var(--border);
		color: var(--text-1);
		font-family: inherit;
		font-size: 12px;
		padding: 5px 8px;
		border-radius: 3px;
	}
	.rm-body input:focus,
	.rm-body select:focus,
	.rm-body textarea:focus {
		outline: none;
		border-color: var(--gold);
	}
	.rm-error {
		color: var(--red);
		font-size: 12px;
		padding: 8px 10px;
		background: color-mix(in srgb, var(--red) 10%, transparent);
		border: 1px solid color-mix(in srgb, var(--red) 40%, transparent);
		border-radius: 3px;
		margin: 10px 0;
	}
	.rm-foot {
		text-align: right;
		margin-top: 12px;
	}
	.rm-foot button {
		background: var(--gold);
		color: var(--bg);
		border: none;
		padding: 7px 18px;
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		border-radius: 3px;
		cursor: pointer;
		font-family: inherit;
	}
	.rm-foot button:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
</style>
