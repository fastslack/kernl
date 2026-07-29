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
  navigate(path: string): void;
}
