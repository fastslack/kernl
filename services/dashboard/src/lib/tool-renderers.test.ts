import { describe, it, expect } from 'bun:test';
import { rendererFor, parseToolInput, setExtToolRenderers, extToolRenderers } from './tool-renderers.js';
import { get } from 'svelte/store';

// Extensions draw their own tools in the agent run views: the manifest lists which tools, the views look them up.

describe('tool renderers', () => {
	it('keeps only well-formed entries from the manifest and finds a tool by name', () => {
		setExtToolRenderers([
			{ slug: 'devops', entry: 'entry.js', version: '2', export: 'mountTool', tools: ['kernel_devops_e2e_run'] },
			{ slug: 'broken', entry: 'x.js' },
			null,
		]);
		expect(get(extToolRenderers)).toHaveLength(1);
		expect(rendererFor('kernel_devops_e2e_run')?.slug).toBe('devops');
		expect(rendererFor('kernel_tasks_create')).toBeUndefined();
		expect(rendererFor(undefined)).toBeUndefined();
		setExtToolRenderers(undefined);
		expect(rendererFor('kernel_devops_e2e_run')).toBeUndefined();
	});

	it('reads a call\'s arguments from the LIVE preview or the stored input, and nothing else', () => {
		expect(parseToolInput('{"base_url":"http://x.test","ticket_id":"dv_1"}')).toEqual({ base_url: 'http://x.test', ticket_id: 'dv_1' });
		expect(parseToolInput({ url: 'http://x.test' })).toEqual({ url: 'http://x.test' });
		expect(parseToolInput('{"base_url":"http://x.te')).toBeNull(); // cut preview
		expect(parseToolInput('[1,2]')).toBeNull();
		expect(parseToolInput(null)).toBeNull();
	});
});
