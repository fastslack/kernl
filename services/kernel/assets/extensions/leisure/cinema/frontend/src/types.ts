/**
 * Local copy of the ext-page contract (canonical source:
 * assets/extensions/_types/ext-page.d.ts). Kept inline so the bundle
 * compiles standalone without cross-package type imports.
 */
export interface ExtPageContext {
  view: string;
  basePath: string;
  authToken: string | null;
  locale: string;
  fetchJson(path: string, init?: RequestInit): Promise<any>;
  /** Authenticated raw fetch — no parsing, no !ok throwing. */
  fetchRaw(path: string, init?: RequestInit): Promise<Response>;
  api: {
    fetchJson(path: string, init?: RequestInit): Promise<any>;
    fetchRaw(path: string, init?: RequestInit): Promise<Response>;
  };
  rpc(
    action: string,
    params?: Record<string, unknown>,
    httpFallback?: () => Promise<any>,
  ): Promise<any>;
  getStore(name: string): { subscribe(run: (value: any) => void): () => void };
  events: {
    on(evt: string, cb: (detail: any) => void): () => void;
    emit(evt: string, detail?: any): void;
  };
  navigate(path: string): void;
}
