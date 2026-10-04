<script lang="ts" context="module">
	export interface BriefDraft {
		value_prop: string;
		audience: string;
		markets: string[];
		languages: string[];
		voice: string;
		pricing: string;
		competitors: string[];
	}

	export const emptyBrief = (): BriefDraft => ({
		value_prop: '', audience: '', markets: [], languages: [], voice: '', pricing: '', competitors: [],
	});
</script>

<script lang="ts">
	/*
	  The project brief, written for someone who has never written one: every
	  field says what it is for and how the agents use it, the two required
	  ones offer a fill-in template and an example, and the rest stay folded
	  under "Más detalles" until wanted.
	*/
	import ChipInput from './ChipInput.svelte';

	export let brief: BriefDraft;
	/** Product name, used to fill the templates. */
	export let productName = '';
	export let idPrefix = 'brief';
	/** Start with the optional section open (editing an existing project). */
	export let openExtras = false;

	let touched: Record<string, boolean> = {};
	let showExample: Record<string, boolean> = {};
	let extras = openExtras;

	const MIN = 25;
	const name = () => productName.trim() || 'tu producto';

	const BRACKETS = /\[[^\]]*\]/;
	$: errors = {
		value_prop: BRACKETS.test(brief.value_prop)
			? 'Reemplazá las partes entre corchetes con lo tuyo.'
			: !brief.value_prop.trim()
			? 'Contá en una o dos frases qué le resolvés a tus clientes.'
			: brief.value_prop.trim().length < MIN ? 'Un poco más de detalle: qué problema resolvés y para quién.' : '',
		audience: BRACKETS.test(brief.audience)
			? 'Reemplazá las partes entre corchetes con lo tuyo.'
			: !brief.audience.trim()
			? 'Contá a quién le vendés: tipo de cliente, dónde está y qué le duele.'
			: brief.audience.trim().length < MIN ? 'Sumá dónde está y qué problema tiene ese cliente.' : '',
	};

	/** Mark everything touched, focus the first invalid field. True when valid. */
	export function validate(): boolean {
		touched = { value_prop: true, audience: true };
		const first = (['value_prop', 'audience'] as const).find((k) => errors[k]);
		if (first) document.getElementById(`${idPrefix}-${first}`)?.focus();
		return !first;
	}

	function useTemplate(field: 'value_prop' | 'audience') {
		if (brief[field].trim()) return;
		brief[field] = field === 'value_prop'
			? `Para [quién], que [tiene tal problema], ${name()} [lo resuelve así], a diferencia de [lo que usan hoy].`
			: `[Tipo de cliente] en [países], de [tamaño]. Decide la compra [quién]. Hoy sufren [problema].`;
		touched[field] = false;
		setTimeout(() => {
			const el = document.getElementById(`${idPrefix}-${field}`) as HTMLTextAreaElement | null;
			if (!el) return;
			el.focus();
			const i = el.value.indexOf('[');
			if (i >= 0) el.setSelectionRange(i, el.value.indexOf(']', i) + 1);
		});
	}
</script>

<div class="field">
	<div class="lab">
		<label for="{idPrefix}-value_prop">¿Qué le ofrecés a tus clientes? <span class="req" aria-hidden="true">*</span></label>
		<span class="tools">
			<button type="button" class="link" on:click={() => useTemplate('value_prop')} disabled={!!brief.value_prop.trim()}>Usar plantilla</button>
			<button type="button" class="link" aria-expanded={!!showExample.value_prop} on:click={() => (showExample.value_prop = !showExample.value_prop)}>Ver ejemplo</button>
		</span>
	</div>
	<textarea id="{idPrefix}-value_prop" rows="3" bind:value={brief.value_prop}
		on:blur={() => (touched.value_prop = true)}
		aria-invalid={touched.value_prop && !!errors.value_prop}
		aria-describedby="{idPrefix}-value_prop-help {idPrefix}-value_prop-err"
		placeholder="Qué problema resolvés, para quién y por qué te elegirían a vos"></textarea>
	<p class="help" id="{idPrefix}-value_prop-help">La <b>propuesta de valor</b>: el mensaje central de todo lo que escriban Marketing y Ventas. Hablá del beneficio para el cliente, no de la lista de funciones.</p>
	{#if showExample.value_prop}
		<p class="example">“Para estudios contables chicos que pierden horas pidiéndole papeles a cada cliente, Contalia junta los comprobantes solo y avisa los vencimientos, sin planillas ni mails sueltos.”</p>
	{/if}
	{#if touched.value_prop && errors.value_prop}<p class="err" id="{idPrefix}-value_prop-err" role="alert">{errors.value_prop}</p>{/if}
</div>

<div class="field">
	<div class="lab">
		<label for="{idPrefix}-audience">¿A quién le vendés? <span class="req" aria-hidden="true">*</span></label>
		<span class="tools">
			<button type="button" class="link" on:click={() => useTemplate('audience')} disabled={!!brief.audience.trim()}>Usar plantilla</button>
			<button type="button" class="link" aria-expanded={!!showExample.audience} on:click={() => (showExample.audience = !showExample.audience)}>Ver ejemplo</button>
		</span>
	</div>
	<textarea id="{idPrefix}-audience" rows="3" bind:value={brief.audience}
		on:blur={() => (touched.audience = true)}
		aria-invalid={touched.audience && !!errors.audience}
		aria-describedby="{idPrefix}-audience-help {idPrefix}-audience-err"
		placeholder="Tipo de cliente, dónde está, de qué tamaño, quién decide y qué le duele"></textarea>
	<p class="help" id="{idPrefix}-audience-help">El <b>público</b>: Ventas lo usa para saber a quién buscar y calificar leads; Marketing, para elegir canal y tono. Si tenés más de uno, poné uno por línea.</p>
	{#if showExample.audience}
		<p class="example">“Estudios contables de 1 a 10 personas en Argentina, con 30 a 200 clientes. Decide el socio titular. Hoy persiguen comprobantes por WhatsApp y se les pasan vencimientos.”</p>
	{/if}
	{#if touched.audience && errors.audience}<p class="err" id="{idPrefix}-audience-err" role="alert">{errors.audience}</p>{/if}
</div>

<button type="button" class="extras-toggle" aria-expanded={extras} on:click={() => (extras = !extras)}>
	<span class="chev" class:open={extras} aria-hidden="true">›</span>
	Más detalles <span class="opt">opcional · ayudan a que los agentes escriban mejor</span>
</button>

{#if extras}
	<div class="extras">
		<div class="field">
			<label for="{idPrefix}-markets">Países o mercados</label>
			<ChipInput id="{idPrefix}-markets" bind:values={brief.markets} placeholder="Escribí y apretá Enter" suggestions={['Argentina', 'España', 'México', 'Chile', 'Uruguay']} />
		</div>
		<div class="field">
			<label for="{idPrefix}-languages">Idiomas en los que se comunica</label>
			<ChipInput id="{idPrefix}-languages" bind:values={brief.languages} placeholder="Escribí y apretá Enter" suggestions={['Español', 'Inglés', 'Portugués']} />
		</div>
		<div class="field">
			<label for="{idPrefix}-voice">Tono de voz</label>
			<input id="{idPrefix}-voice" bind:value={brief.voice} placeholder="Ej.: cercano y claro, sin tecnicismos; tuteo" />
			<p class="help">Cómo suena la marca cuando escriben los agentes.</p>
		</div>
		<div class="field">
			<label for="{idPrefix}-pricing">Precios y planes</label>
			<input id="{idPrefix}-pricing" bind:value={brief.pricing} placeholder="Ej.: plan gratis hasta 3 usuarios; Pro por profesional" />
			<p class="help">Ventas lo usa al armar propuestas. Si todavía no está definido, dejalo vacío.</p>
		</div>
		<div class="field">
			<label for="{idPrefix}-competitors">Competidores</label>
			<ChipInput id="{idPrefix}-competitors" bind:values={brief.competitors} placeholder="Nombres de la competencia" />
			<p class="help">Marketing los sigue y Ventas los usa para diferenciarte.</p>
		</div>
	</div>
{/if}

<style>
	.field { display: flex; flex-direction: column; gap: 6px; }
	.lab { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
	label { font-size: 14px; font-weight: 600; color: var(--text-1); }
	.req { color: var(--teal); }
	.tools { display: flex; gap: 12px; }
	.link { background: none; border: 0; padding: 4px 0; color: var(--teal); font: inherit; font-size: 12.5px; cursor: pointer; }
	.link:disabled { color: var(--text-3); cursor: default; }
	.link:not(:disabled):hover { text-decoration: underline; }
	textarea, input {
		background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text-1);
		padding: 9px 11px; font: inherit; font-size: 14px; line-height: 1.5; resize: vertical;
	}
	textarea:focus, input:focus { outline: 2px solid var(--teal); outline-offset: 1px; border-color: transparent; }
	textarea[aria-invalid='true'] { border-color: var(--red); }
	.help { margin: 0; font-size: 12.5px; line-height: 1.5; color: var(--text-2); }
	.help b { color: var(--text-1); font-weight: 600; }
	.example {
		margin: 0; font-size: 13px; line-height: 1.5; color: var(--text-1);
		border-left: 3px solid var(--teal); background: var(--surface-2); padding: 8px 12px; border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
	}
	.err { margin: 0; font-size: 12.5px; color: var(--red); }
	.extras-toggle {
		display: flex; align-items: center; gap: 8px; background: none; border: 0; padding: 6px 0; cursor: pointer;
		color: var(--text-1); font: inherit; font-size: 14px; font-weight: 600; text-align: left;
	}
	.opt { font-weight: 400; font-size: 12.5px; color: var(--text-3); }
	.chev { display: inline-block; transition: transform 150ms ease-out; color: var(--text-2); }
	.chev.open { transform: rotate(90deg); }
	.extras { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 18px; }
	@media (prefers-reduced-motion: reduce) { .chev { transition: none; } }
	@media (max-width: 900px) { .extras { grid-template-columns: 1fr; } }
</style>
