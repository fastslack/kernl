import type { GoogleAuth } from "./auth.js";
import { log } from "../../../../../src/core/logger.js";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

export class GoogleClient {
  constructor(private auth: GoogleAuth) {}

  async get<T>(url: string, params?: Record<string, string>): Promise<T> {
    const token = await this.auth.getAccessToken();
    const fullUrl = params
      ? `${url}?${new URLSearchParams(params).toString()}`
      : url;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const response = await fetch(fullUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (response.ok) {
        return (await response.json()) as T;
      }

      if (response.status === 429) {
        const delay = BASE_DELAY_MS * 2 ** attempt;
        log.warn(`Rate limited (429), retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(delay);
        lastError = new Error(`Rate limited after ${MAX_RETRIES} retries`);
        continue;
      }

      if (response.status === 401) {
        throw new Error("Authentication expired. Run kernel_google_auth to re-authenticate.");
      }

      const text = await response.text();
      throw new Error(`Google API error ${response.status}: ${text}`);
    }

    throw lastError ?? new Error("Request failed");
  }

  async post<T>(url: string, body: unknown): Promise<T> {
    const token = await this.auth.getAccessToken();

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (response.ok) {
        return (await response.json()) as T;
      }

      if (response.status === 429) {
        const delay = BASE_DELAY_MS * 2 ** attempt;
        log.warn(`Rate limited (429), retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(delay);
        lastError = new Error(`Rate limited after ${MAX_RETRIES} retries`);
        continue;
      }

      if (response.status === 401) {
        throw new Error("Authentication expired. Run kernel_google_auth to re-authenticate.");
      }

      const text = await response.text();
      throw new Error(`Google API error ${response.status}: ${text}`);
    }

    throw lastError ?? new Error("Request failed");
  }

  async getPaginated<T>(
    url: string,
    params: Record<string, string>,
    itemsKey: string,
  ): Promise<T[]> {
    const allItems: T[] = [];
    let pageToken: string | undefined;

    do {
      const queryParams = { ...params };
      if (pageToken) {
        queryParams.pageToken = pageToken;
      }

      const response = await this.get<Record<string, unknown>>(url, queryParams);
      const items = (response[itemsKey] as T[] | undefined) ?? [];
      allItems.push(...items);

      pageToken = response.nextPageToken as string | undefined;
    } while (pageToken);

    return allItems;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
