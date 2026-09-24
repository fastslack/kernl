/**
 * Loose-args reading for operations reached over RPC and HTTP.
 *
 * An RPC action gets `Record<string, unknown>` straight off the wire, and the
 * handlers used to read it one field at a time:
 * `typeof args.x === "string" ? args.x : undefined`. `pickArgs` is that line
 * for a whole shape at once: each declared key is kept only when its value has
 * the declared kind, and anything else is left out. It never throws, and
 * required fields are still checked by the caller, with its own message.
 */

export type ArgKind = "string" | "number" | "boolean" | "string[]" | "object";

type KindType<K extends ArgKind> =
  K extends "string" ? string
  : K extends "number" ? number
  : K extends "boolean" ? boolean
  : K extends "string[]" ? string[]
  : Record<string, unknown>;

export type PickedArgs<S extends Record<string, ArgKind>> = { [K in keyof S]?: KindType<S[K]> };

const isNumeric = (v: unknown) => typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v));

/**
 * `number` also takes a numeric string, since a query string carries nothing
 * else; it comes back as a number.
 */
export function pickArgs<S extends Record<string, ArgKind>>(args: Record<string, unknown>, shape: S): PickedArgs<S> {
  const out: Record<string, unknown> = {};
  for (const [key, kind] of Object.entries(shape)) {
    const v = args[key];
    switch (kind) {
      case "string": if (typeof v === "string") out[key] = v; break;
      case "number":
        if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
        else if (isNumeric(v)) out[key] = Number(v);
        break;
      case "boolean": if (typeof v === "boolean") out[key] = v; break;
      case "string[]": if (Array.isArray(v) && v.every((x) => typeof x === "string")) out[key] = v; break;
      case "object": if (typeof v === "object" && v !== null && !Array.isArray(v)) out[key] = v; break;
    }
  }
  return out as PickedArgs<S>;
}

/**
 * One implementation of an action the dashboard can reach two ways. It calls
 * through `rpcOrCall`, which uses the WS RPC when it is up and the HTTP route
 * otherwise, so both transports have to answer the same thing. They do when
 * both are this one function: the RPC action hands it its args, and
 * `server.operation()` hands it query, body and path params merged.
 * Throw `HttpError` for a 4xx: the route keeps the status, the RPC the message.
 */
export type Operation = (input: Record<string, unknown>) => unknown;

/** The RPC side of a set of operations: the key is the action name. */
export function rpcActionsFrom(ops: Record<string, Operation>): Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<unknown> }> {
  return Object.entries(ops).map(([name, op]) => ({ name, handler: async (args) => op(args) }));
}
