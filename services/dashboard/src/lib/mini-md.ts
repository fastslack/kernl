/**
 * Lightweight markdown-to-HTML converter for flow widget cards.
 * Handles: headers, bold, code, lists, bar charts (█), horizontal rules.
 * No external dependencies.
 */

function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function miniMd(md: string): string {
	const lines = md.split('\n');
	const out: string[] = [];
	let inList = false;

	for (const raw of lines) {
		const line = raw.trimEnd();

		// Blank line
		if (!line.trim()) {
			if (inList) { out.push('</ul>'); inList = false; }
			continue;
		}

		// Horizontal rule
		if (/^---+$/.test(line.trim())) {
			if (inList) { out.push('</ul>'); inList = false; }
			out.push('<hr/>');
			continue;
		}

		// Headers
		const hMatch = line.match(/^(#{1,4})\s+(.+)/);
		if (hMatch) {
			if (inList) { out.push('</ul>'); inList = false; }
			const level = hMatch[1].length;
			out.push(`<h${level}>${inline(hMatch[2])}</h${level}>`);
			continue;
		}

		// Unordered list
		if (/^\s*[-*]\s+/.test(line)) {
			if (!inList) { out.push('<ul>'); inList = true; }
			out.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ''))}</li>`);
			continue;
		}

		// Regular line — check if it has bar chart characters (█░)
		if (inList) { out.push('</ul>'); inList = false; }
		const hasBar = /[█░▓▒]/.test(line);
		if (hasBar) {
			out.push(`<div class="md-bar">${inline(line)}</div>`);
		} else {
			out.push(`<div class="md-line">${inline(line)}</div>`);
		}
	}

	if (inList) out.push('</ul>');
	return out.join('\n');
}

function inline(text: string): string {
	// Collapse magnet URIs BEFORE HTML escaping so we can keep the original
	// magnet around for the data-magnet attribute. Long magnets are visual
	// noise — replace with a compact "🧲 <dn>" pill that copies on click.
	const magnetTokens: Array<{ ph: string; html: string }> = [];
	let collapsed = text;
	let i = 0;
	collapsed = collapsed.replace(/magnet:\?[^\s)\]<>"'`]+/g, (m) => {
		const ph = `MAGNET${i++}`;
		magnetTokens.push({ ph, html: renderMagnetPill(m) });
		return ph;
	});

	let s = escapeHtml(collapsed);
	// Bold **text** or __text__
	s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
	s = s.replace(/__(.+?)__/g, '<strong>$1</strong>');
	// Inline code `text`
	s = s.replace(/`(.+?)`/g, '<code>$1</code>');
	// Italic *text* or _text_ (after bold to avoid conflicts)
	s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');

	// Swap magnet placeholders back in.
	for (const { ph, html } of magnetTokens) {
		s = s.replace(ph, html);
	}
	return s;
}

function renderMagnetPill(magnet: string): string {
	let dn = '';
	let infohash = '';
	try {
		const q = magnet.slice('magnet:?'.length);
		for (const part of q.split('&')) {
			if (part.startsWith('dn=')) {
				try { dn = decodeURIComponent(part.slice(3)).replace(/\+/g, ' '); } catch { dn = part.slice(3); }
			} else if (part.startsWith('xt=urn:btih:')) {
				infohash = part.slice('xt=urn:btih:'.length);
			}
		}
	} catch { /* ignore */ }
	const label = dn || (infohash ? `infohash ${infohash.slice(0, 12)}…` : 'magnet');
	const safeLabel = label
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
	const safeMagnet = magnet
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;');
	return `<a class="md-magnet" href="${safeMagnet}" data-magnet="${safeMagnet}" title="click to copy magnet · ${safeLabel}">🧲 ${safeLabel}</a>`;
}
