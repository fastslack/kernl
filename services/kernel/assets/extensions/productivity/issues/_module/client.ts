import { log } from "../../../../../src/core/logger.js";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

export class IssueClient {
  private apiBase: string;
  private headers: Record<string, string>;

  constructor(
    private provider: "github" | "gitlab",
    private token: string,
    baseUrl?: string,
  ) {
    if (provider === "github") {
      this.apiBase = "https://api.github.com";
      this.headers = {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      };
    } else {
      this.apiBase = baseUrl
        ? `${baseUrl.replace(/\/+$/, "")}/api/v4`
        : "https://gitlab.com/api/v4";
      this.headers = {
        "PRIVATE-TOKEN": token,
      };
    }
  }

  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`${this.apiBase}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const res = await fetch(url.toString(), { headers: this.headers });

      if (res.ok) {
        return (await res.json()) as T;
      }

      if (res.status === 429 || res.status >= 500) {
        if (attempt < MAX_RETRIES) {
          const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
          log.warn(`${this.provider} API ${res.status}, retrying in ${delay}ms...`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
      }

      const body = await res.text().catch(() => "");
      throw new Error(`${this.provider} API ${res.status}: ${res.statusText} ${body}`);
    }

    throw new Error(`${this.provider} API: max retries exceeded`);
  }

  async getPaginated<T>(path: string, params: Record<string, string> = {}): Promise<T[]> {
    const all: T[] = [];

    if (this.provider === "github") {
      let page = 1;
      const perPage = params.per_page ?? "100";
      while (true) {
        const url = new URL(`${this.apiBase}${path}`);
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
        url.searchParams.set("page", String(page));
        url.searchParams.set("per_page", perPage);

        let res: Response | null = null;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          res = await fetch(url.toString(), { headers: this.headers });
          if (res.ok) break;
          if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
            await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * Math.pow(2, attempt)));
            continue;
          }
          throw new Error(`${this.provider} API ${res.status}: ${res.statusText}`);
        }

        const items = (await res!.json()) as T[];
        all.push(...items);
        if (items.length < parseInt(perPage, 10)) break;

        // Check Link header for next page
        const link = res!.headers.get("link") ?? "";
        if (!link.includes('rel="next"')) break;
        page++;
      }
    } else {
      // GitLab pagination via x-next-page header
      let page = "1";
      const perPage = params.per_page ?? "100";
      while (page) {
        const url = new URL(`${this.apiBase}${path}`);
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
        url.searchParams.set("page", page);
        url.searchParams.set("per_page", perPage);

        let res: Response | null = null;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          res = await fetch(url.toString(), { headers: this.headers });
          if (res.ok) break;
          if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
            await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * Math.pow(2, attempt)));
            continue;
          }
          throw new Error(`${this.provider} API ${res.status}: ${res.statusText}`);
        }

        const items = (await res!.json()) as T[];
        all.push(...items);

        const nextPage = res!.headers.get("x-next-page") ?? "";
        page = nextPage && nextPage !== page ? nextPage : "";
      }
    }

    return all;
  }
}
