/**
 * Why a link in an agent's model chain is alive or dead.
 *
 * The executor already decides this on every run and says nothing about it
 * until the run fails: it skips entries whose provider is not available
 * (executor.ts:572), drops entries whose provider cannot run a tool loop
 * (executor.ts:597), and pushes quota-blocked providers to the tail
 * (executor.ts:634). The panel that reports the failure has every one of
 * those facts in the `/api/llm-providers` payload it already fetches, so the
 * verdict can be shown next to the row instead of arriving as a run error.
 *
 * Pure, and here rather than in the component, because "is this chain going
 * to work" is exactly the kind of answer a browser is a bad place to check.
 *
 * ── Two names for one provider ──
 * A chain entry stores the *adapter* name (`claude_code`) while the status
 * payload keys on the registry *slug* (`claude-code`). readiness.ts:124 calls
 * them aliases of the same instance and the executor's provider map holds
 * both, so a lookup that compared strings literally would fail to find the
 * one provider the whole feature exists to explain. `providerKey` squashes
 * separators so both spellings land on the same key.
 */

export interface ProviderStatus {
  slug: string;
  name: string;
  ready: boolean;
  error?: string;
  exhausted?: boolean;
  /**
   * `false` = cannot carry a native tool loop. Added by
   * provider-routes.ts:decorateToolLoop; `undefined` means the kernel has no
   * adapter for the slug and genuinely does not know.
   */
  supportsToolLoop?: boolean;
  capabilities?: {
    tools?: boolean;
    vision?: boolean;
    thinking?: boolean;
    contextWindow?: number;
  };
}

export type LinkState =
  /** Nothing chosen — the kernel falls back to its default provider. */
  | 'unset'
  /** No provider in the payload answers to this name. */
  | 'unknown'
  /** Present, but has no credentials: the executor skips it. */
  | 'not-configured'
  /** Present and configured, but cannot run the tool loop this run needs. */
  | 'no-tools'
  /** Usable, but out of quota — the executor demotes it to the tail. */
  | 'exhausted'
  | 'ok';

export interface LinkHealth {
  state: LinkState;
  /** Short reason for the row. Empty when there is nothing to say. */
  label: string;
  /** The long form, for a title attribute. */
  detail: string;
  /** Would the executor still attempt this link on the next run? */
  usable: boolean;
}

/** Separator-insensitive identity: `claude_code` and `claude-code` are one. */
export function providerKey(name: string): string {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The status row for a chain entry's provider name, by slug then by name. */
export function findProvider(
  providers: ProviderStatus[],
  name: string,
): ProviderStatus | undefined {
  const key = providerKey(name);
  if (!key) return undefined;
  return (
    providers.find((p) => providerKey(p.slug) === key) ??
    providers.find((p) => providerKey(p.name) === key)
  );
}

/**
 * Can this provider run a tool loop? `undefined` when nothing in the payload
 * says either way — an older kernel omits `supportsToolLoop` entirely, and
 * claiming `true` there would green-light the one provider that cannot.
 *
 * `capabilities.tools === false` counts as a "no" in its own right. It is the
 * same fact the adapter declares, reported by kernels that predate
 * `supportsToolLoop`, and reading only the newer field would leave the
 * claude_code shim unmarked on exactly the deployments where it is the
 * default.
 */
export function toolCapable(p: ProviderStatus | undefined): boolean | undefined {
  if (!p) return undefined;
  if (p.supportsToolLoop === false) return false;
  if (p.capabilities?.tools === false) return false;
  if (p.supportsToolLoop === true) return true;
  return undefined;
}

/**
 * The verdict for one chain entry.
 *
 * Order matters and mirrors the executor: availability is checked before
 * tool capability, because an unconfigured provider never reaches the tool
 * filter. Quota comes last — it re-orders the chain, it does not remove it.
 */
export function linkHealth(
  link: { provider: string; model: string },
  providers: ProviderStatus[],
  requiresTools: boolean,
): LinkHealth {
  const name = String(link?.provider ?? '');
  if (!name) {
    return {
      state: 'unset',
      label: 'kernel default',
      detail: 'No provider chosen — the kernel uses its configured default provider.',
      usable: true,
    };
  }

  const p = findProvider(providers, name);
  if (!p) {
    return {
      state: 'unknown',
      label: 'not installed',
      detail: `No provider named "${name}" is registered on this kernel.`,
      usable: false,
    };
  }

  if (!p.ready) {
    return {
      state: 'not-configured',
      label: 'not configured',
      detail: p.error
        ? `${p.name} is not usable: ${p.error}`
        : `${p.name} has no working configuration, so the executor skips it.`,
      usable: false,
    };
  }

  if (requiresTools && toolCapable(p) === false) {
    return {
      state: 'no-tools',
      label: 'cannot run tools',
      detail:
        `${p.name} cannot execute a tool loop, so an agent run that carries tools ` +
        `drops it from the chain.`,
      usable: false,
    };
  }

  if (p.exhausted) {
    return {
      state: 'exhausted',
      label: 'quota exhausted',
      detail: `${p.name} is out of quota — the executor tries it last.`,
      usable: true,
    };
  }

  return { state: 'ok', label: '', detail: `${p.name} is ready.`, usable: true };
}

/**
 * Would the next run find anything to call?
 *
 * The exact question behind "No LLM provider in the chain can run tool
 * calls": if no link survives, the run fails before it starts, and the panel
 * can say so before the user presses Run.
 */
export function chainUsable(
  links: Array<{ provider: string; model: string }>,
  providers: ProviderStatus[],
  requiresTools: boolean,
): boolean {
  if (links.length === 0) return true; // kernel default takes over
  return links.some((l) => linkHealth(l, providers, requiresTools).usable);
}
