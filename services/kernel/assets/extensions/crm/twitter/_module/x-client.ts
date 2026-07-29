import { createHmac, randomBytes } from "node:crypto";
import { log } from "../../../../../src/core/logger.js";

// ── X API v2 Client (OAuth 1.0a) ─────────────────────────
// Posts tweets using the X API v2 with user-context OAuth 1.0a authentication.
// No external dependencies — uses Node.js crypto for HMAC-SHA1 signing.

interface OAuthCredentials {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
}

interface TweetResponse {
  data: {
    id: string;
    text: string;
  };
}

interface UserResponse {
  data: {
    id: string;
    name: string;
    username: string;
    public_metrics: {
      followers_count: number;
      following_count: number;
      tweet_count: number;
      listed_count: number;
    };
  };
}

interface MentionResponse {
  data?: Array<{
    id: string;
    text: string;
    author_id: string;
    created_at: string;
  }>;
  includes?: {
    users?: Array<{
      id: string;
      name: string;
      username: string;
    }>;
  };
  meta?: {
    newest_id?: string;
    oldest_id?: string;
    result_count?: number;
  };
}

interface TweetMetricsResponse {
  data?: {
    id: string;
    public_metrics: {
      retweet_count: number;
      reply_count: number;
      like_count: number;
      quote_count: number;
      bookmark_count: number;
      impression_count: number;
    };
  };
}

// ── OAuth 1.0a Signing ────────────────────────────────────

function percentEncode(str: string): string {
  return encodeURIComponent(str)
    .replace(/!/g, "%21")
    .replace(/\*/g, "%2A")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
}

function generateNonce(): string {
  return randomBytes(16).toString("hex");
}

function buildOAuthHeader(
  method: string,
  url: string,
  creds: OAuthCredentials,
  bodyParams?: Record<string, string>,
): string {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = generateNonce();

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };

  // Merge all params for signature base
  const allParams: Record<string, string> = { ...oauthParams, ...(bodyParams ?? {}) };

  // Sort and encode
  const paramString = Object.keys(allParams)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(allParams[k])}`)
    .join("&");

  // Signature base string
  const baseString = `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(paramString)}`;

  // Signing key
  const signingKey = `${percentEncode(creds.apiSecret)}&${percentEncode(creds.accessSecret)}`;

  // HMAC-SHA1
  const signature = createHmac("sha1", signingKey).update(baseString).digest("base64");

  oauthParams["oauth_signature"] = signature;

  // Build header
  const headerParts = Object.keys(oauthParams)
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`)
    .join(", ");

  return `OAuth ${headerParts}`;
}

// ── X API Client ──────────────────────────────────────────

export class XApiClient {
  private baseUrl = "https://api.x.com/2";

  constructor(private creds: OAuthCredentials) {}

  /** Check if credentials are configured */
  get isConfigured(): boolean {
    return !!(this.creds.apiKey && this.creds.apiSecret && this.creds.accessToken && this.creds.accessSecret);
  }

  /** Post a tweet */
  async postTweet(text: string, opts?: {
    reply_to_id?: string;
    quote_tweet_id?: string;
  }): Promise<{ ok: true; data: TweetResponse["data"] } | { ok: false; error: string }> {
    const url = `${this.baseUrl}/tweets`;
    const body: Record<string, unknown> = { text };

    if (opts?.reply_to_id) {
      body.reply = { in_reply_to_tweet_id: opts.reply_to_id };
    }
    if (opts?.quote_tweet_id) {
      body.quote_tweet_id = opts.quote_tweet_id;
    }

    const authHeader = buildOAuthHeader("POST", url, this.creds);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errBody = await res.text();
        log.error(`X API postTweet failed: ${res.status} ${errBody}`);
        return { ok: false, error: `HTTP ${res.status}: ${errBody.slice(0, 200)}` };
      }

      const data = (await res.json()) as TweetResponse;
      return { ok: true, data: data.data };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`X API postTweet error: ${msg}`);
      return { ok: false, error: msg };
    }
  }

  /** Delete a tweet */
  async deleteTweet(tweetId: string): Promise<boolean> {
    const url = `${this.baseUrl}/tweets/${tweetId}`;
    const authHeader = buildOAuthHeader("DELETE", url, this.creds);

    try {
      const res = await fetch(url, {
        method: "DELETE",
        headers: { Authorization: authHeader },
      });
      return res.ok;
    } catch (err) {
      log.error(`X API deleteTweet error:`, err);
      return false;
    }
  }

  /** Get authenticated user info (for metrics snapshot) */
  async getMe(): Promise<UserResponse["data"] | null> {
    const url = `${this.baseUrl}/users/me?user.fields=public_metrics`;
    const authHeader = buildOAuthHeader("GET", url, this.creds);

    try {
      const res = await fetch(url, {
        headers: { Authorization: authHeader },
      });
      if (!res.ok) return null;
      const data = (await res.json()) as UserResponse;
      return data.data;
    } catch (err) {
      log.error(`X API getMe error:`, err);
      return null;
    }
  }

  /** Get mentions for the authenticated user */
  async getMentions(userId: string, sinceId?: string): Promise<MentionResponse | null> {
    let url = `${this.baseUrl}/users/${userId}/mentions?tweet.fields=created_at,author_id&expansions=author_id&user.fields=name,username&max_results=20`;
    if (sinceId) url += `&since_id=${sinceId}`;

    const authHeader = buildOAuthHeader("GET", url, this.creds);

    try {
      const res = await fetch(url, {
        headers: { Authorization: authHeader },
      });
      if (!res.ok) return null;
      return (await res.json()) as MentionResponse;
    } catch (err) {
      log.error(`X API getMentions error:`, err);
      return null;
    }
  }

  /** Get tweet metrics */
  async getTweetMetrics(tweetId: string): Promise<TweetMetricsResponse["data"] | null> {
    const url = `${this.baseUrl}/tweets/${tweetId}?tweet.fields=public_metrics`;
    const authHeader = buildOAuthHeader("GET", url, this.creds);

    try {
      const res = await fetch(url, {
        headers: { Authorization: authHeader },
      });
      if (!res.ok) return null;
      const data = (await res.json()) as TweetMetricsResponse;
      return data.data ?? null;
    } catch (err) {
      log.error(`X API getTweetMetrics error:`, err);
      return null;
    }
  }
}
