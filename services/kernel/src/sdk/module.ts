/**
 * Module factories — the `_module/index.ts` of an extension, without the
 * boilerplate every one of them repeated.
 *
 * A module's index used to be the same ~50 lines with the names changed: a
 * `let tools = []` and a `let serviceRef = null` closed over, runMigrations
 * with the module's name, a service built in `initialize`, `getTools()`
 * returning the variable, `getRpcActions()` guarding on the ref, a dashboard
 * descriptor spelling the module's name four times, and an empty
 * `shutdown()`. `defineModule` takes the parts that differ.
 */

import type {
  AgentDriver,
  DashboardChannel,
  DashboardDescriptor,
  ExtensibleModule,
  ModuleContext,
  ResourceProvider,
  RpcAction,
  ToolDefinition,
} from "./types.js";
import { runMigrations, type Migration } from "./migrations.js";

export interface ModuleSpec<S> {
  name: string;
  /** Applied before `init`, under `migrationsKey` (default: `name`). */
  migrations?: Migration[];
  migrationsKey?: string;
  /** Build what the module runs on (its service, usually) from the kernel's context. */
  init?: (ctx: ModuleContext) => S | Promise<S>;
  tools?: (state: S, ctx: ModuleContext) => ToolDefinition[];
  rpc?: (state: S) => RpcAction[] | Promise<RpcAction[]>;
  dashboardRpc?: (state: S, deps?: any) => RpcAction[];
  /**
   * Static, or built from the state. The kernel may ask before `init` has
   * run, in which case the function gets `null`.
   */
  dashboard?: DashboardDescriptor | ((state: S | null) => DashboardDescriptor | null);
  resources?: (state: S) => ResourceProvider[];
  queryChannels?: (state: S) => Record<string, () => Promise<unknown> | unknown> | undefined;
  agentHandlers?: (state: S) => Record<string, () => Promise<unknown>>;
  agentDrivers?: (state: S) => AgentDriver[];
  shutdown?: (state: S) => void | Promise<void>;
}

export function defineModule<S = void>(spec: ModuleSpec<S>): ExtensibleModule {
  let state: { value: S } | null = null;
  let tools: ToolDefinition[] = [];
  const withState = <R>(fn: ((s: S) => R) | undefined, fallback: R): R =>
    fn && state ? fn(state.value) : fallback;

  const mod: ExtensibleModule = {
    name: spec.name,

    async initialize(ctx: ModuleContext) {
      if (spec.migrations) runMigrations(ctx.sqlite, spec.migrationsKey ?? spec.name, spec.migrations);
      state = { value: spec.init ? await spec.init(ctx) : (undefined as S) };
      tools = spec.tools ? spec.tools(state.value, ctx) : [];
    },

    getTools: () => tools,

    // After shutdown the module is back to its pre-init shape: no tools, and
    // the state-backed hooks answer empty until the next initialize().
    async shutdown() {
      const current = state;
      state = null;
      tools = [];
      if (spec.shutdown && current) await spec.shutdown(current.value);
    },
  };

  // Optional hooks exist only when the spec provides them: the registry
  // treats a present hook as "this module contributes one".
  if (spec.rpc) mod.getRpcActions = () => withState(spec.rpc, []);
  if (spec.dashboardRpc) mod.getDashboardRpcActions = (deps?: any) => withState((s) => spec.dashboardRpc!(s, deps), []);
  if (spec.dashboard) {
    const d = spec.dashboard;
    mod.getDashboardDescriptor = () => (typeof d === "function" ? d(state ? state.value : null) : d);
  }
  if (spec.resources) mod.getResources = () => withState(spec.resources, []);
  if (spec.queryChannels) mod.getQueryChannels = () => withState(spec.queryChannels, undefined);
  if (spec.agentHandlers) mod.getAgentHandlers = () => withState(spec.agentHandlers, {});
  if (spec.agentDrivers) mod.getAgentDrivers = () => withState(spec.agentDrivers, []);
  return mod;
}

/**
 * The dashboard descriptor almost every module writes by hand: one channel
 * named after the module, mapped to itself, backed by a store of the same
 * name and fetched from `/api/dashboard/<name>`. `extra` adds nav, pages,
 * routes or more channels.
 */
export function dashboardChannel(
  name: string,
  query: DashboardChannel["query"],
  extra: DashboardDescriptor = {},
): DashboardDescriptor {
  return {
    ...extra,
    channels: [{ name, query }, ...(extra.channels ?? [])],
    channelMappings: [{ moduleKey: name, channels: [name] }, ...(extra.channelMappings ?? [])],
    stores: [name, ...(extra.stores ?? [])],
    fetchEndpoints: [{ url: `/api/dashboard/${name}`, store: name }, ...(extra.fetchEndpoints ?? [])],
  };
}

/**
 * A notification-channel extension: registers its provider factory on the
 * kernel's NotificationRegistry and does nothing else.
 */
export function notificationChannelModule(
  name: string,
  providerId: string,
  createProvider: Parameters<ReturnType<ModuleContext["notifier"]["getRegistry"]>["registerFactory"]>[1],
): ExtensibleModule {
  return defineModule({
    name,
    init: (ctx) => { ctx.notifier.getRegistry().registerFactory(providerId, createProvider); },
  });
}
