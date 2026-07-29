/**
 * Full-featured markdown renderer for the workspace viewer.
 * Handles: headings, paragraphs, bold/italic/code/strike, links,
 * fenced code blocks, blockquotes, ordered + unordered lists (with nesting),
 * horizontal rules, tables.
 *
 * No external deps. Escapes HTML; only emits tags we generate.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inline(text: string): string {
  let s = escapeHtml(text);
  // Inline code (first — preserves content from other replacements)
  s = s.replace(/`([^`]+?)`/g, (_m, code) => `<code>${code}</code>`);
  // Links [text](url) — url must not contain whitespace
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, txt, url) => {
    const safe = /^(https?:|mailto:|#|\/)/i.test(url) ? url : '#';
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${txt}</a>`;
  });
  // Bold **x** / __x__
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_\n]+?)__/g, '<strong>$1</strong>');
  // Italic *x* / _x_
  s = s.replace(/(^|[\s>])\*([^*\n]+?)\*(?=[\s<.,;:!?)]|$)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[\s>])_([^_\n]+?)_(?=[\s<.,;:!?)]|$)/g, '$1<em>$2</em>');
  // Strikethrough ~~x~~
  s = s.replace(/~~([^~\n]+?)~~/g, '<del>$1</del>');
  return s;
}

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'para'; text: string }
  | { type: 'code'; lang: string; content: string }
  | { type: 'quote'; lines: string[] }
  | { type: 'list'; ordered: boolean; items: string[][] }
  | { type: 'hr' }
  | { type: 'table'; header: string[]; rows: string[][] };

export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank line — skip
    if (!line.trim()) { i++; continue; }

    // Fenced code block
    const fence = line.match(/^(```+|~~~+)\s*([^\s`~]*)/);
    if (fence) {
      const marker = fence[1];
      const lang = fence[2] ?? '';
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith(marker)) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip closing fence (or EOF)
      blocks.push({ type: 'code', lang, content: buf.join('\n') });
      continue;
    }

    // Horizontal rule
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // Heading
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) {
      blocks.push({ type: 'heading', level: h[1].length, text: h[2] });
      i++;
      continue;
    }

    // Blockquote
    if (/^\s{0,3}>/.test(line)) {
      const qLines: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) {
        qLines.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'quote', lines: qLines });
      continue;
    }

    // Table (header | --- | rows)
    if (/^\s*\|?.+\|.+$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      const split = (s: string) => s.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
      const header = split(line);
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|?.+\|.+$/.test(lines[i])) {
        rows.push(split(lines[i]));
        i++;
      }
      blocks.push({ type: 'table', header, rows });
      continue;
    }

    // Lists (ordered / unordered, with simple nesting by indent)
    const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (listMatch) {
      const ordered = /^\d+\./.test(listMatch[2]);
      const items: string[][] = [];
      while (i < lines.length) {
        const lm = lines[i].match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
        if (!lm) {
          // Continuation (indented, non-blank, no bullet) merges into the last item
          if (items.length > 0 && /^\s+\S/.test(lines[i]) && lines[i].trim() !== '') {
            items[items.length - 1].push(lines[i].trim());
            i++;
            continue;
          }
          break;
        }
        const sameKind = ordered === /^\d+\./.test(lm[2]);
        if (!sameKind) break;
        items.push([lm[3]]);
        i++;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    // Paragraph — consume until blank line / block delimiter
    const pLines: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      pLines.push(lines[i]);
      i++;
    }
    blocks.push({ type: 'para', text: pLines.join('\n') });
  }

  return blocks.map(renderBlock).join('\n');
}

function isBlockStart(line: string): boolean {
  return (
    /^(```+|~~~+)/.test(line) ||
    /^#{1,6}\s/.test(line) ||
    /^\s{0,3}>/.test(line) ||
    /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line) ||
    /^(\s*)([-*+]|\d+\.)\s+/.test(line)
  );
}

function renderBlock(b: Block): string {
  switch (b.type) {
    case 'heading':
      return `<h${b.level}>${inline(b.text)}</h${b.level}>`;
    case 'para':
      return `<p>${inline(b.text.replace(/\n/g, ' '))}</p>`;
    case 'code':
      return `<pre class="md-code"><code${b.lang ? ` data-lang="${escapeHtml(b.lang)}"` : ''}>${escapeHtml(b.content)}</code></pre>`;
    case 'quote':
      return `<blockquote>${renderMarkdown(b.lines.join('\n'))}</blockquote>`;
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      const items = b.items.map(lines => `<li>${inline(lines.join(' '))}</li>`).join('');
      return `<${tag}>${items}</${tag}>`;
    }
    case 'hr':
      return '<hr/>';
    case 'table': {
      const head = `<tr>${b.header.map(h => `<th>${inline(h)}</th>`).join('')}</tr>`;
      const body = b.rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('');
      return `<table class="md-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
    }
  }
}
