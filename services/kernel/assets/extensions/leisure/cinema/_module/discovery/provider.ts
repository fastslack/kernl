/**
 * Pluggable subtitle-discovery providers.
 *
 * Each provider exposes the same surface — `available`, `query`,
 * `publish`, `subscribe` — so the cinema module can iterate over a
 * registry and aggregate results without knowing about Nostr, archive.org,
 * IPFS, or whatever third option ships next.
 *
 * Design notes:
 *   - Providers MUST NOT touch SQLite directly. They translate between
 *     their own wire format and the shared `SubAnnouncement` shape; the
 *     CinemaSubsService is what stores them.
 *   - Providers are stateless from the catalog's POV: re-running `query`
 *     re-emits everything they currently know.
 *   - `publish` returns enough info that the service can dedupe later
 *     (provider_event_id is the lookup key).
 *   - Some providers are read-only (archive.org without credentials).
 *     Set `canPublish: false` and throw NotSupported on publish().
 */

export type ProviderId = "nostr" | "archive_org" | "ipfs" | string;

export interface SubAnnouncement {
  /** Stable id of the underlying record on the provider. For Nostr this
   *  is the event id; for archive.org it's the file path inside the item. */
  providerEventId: string;
  /** Which provider observed/produced it. */
  providerId: ProviderId;

  /** archive.org item identifier the sub belongs to. */
  identifier: string;

  /** ISO codes; tgtLang is required, srcLang optional (auto-transcribe). */
  srcLang: string;
  tgtLang: string;
  engine: string;
  engineVersion: string;

  /** Trust anchor — x-only secp256k1 hex (Nostr-style) or empty if the
   *  provider doesn't model identity (archive.org has anon uploads). */
  signerPubkey: string;

  /** How peers reach the actual VTT/SRT bytes. At least one of the two
   *  should be populated; provider-specific decisions on which. */
  magnet: string;
  webseedUrl: string;

  /** Integrity. Empty when the provider doesn't expose a hash. */
  sha256: string;
  sizeBytes: number;

  /** Free-form description / notes. */
  content: string;

  /** When the announcement was created on the provider (ISO). */
  observedAt: string;
}

export interface SubFilter {
  /** archive.org identifier we want subs for. Most queries are scoped this way. */
  identifier?: string;
  /** Optional language filter — `["es"]` etc. */
  tgtLang?: string[];
  /** Cap on results returned by one query. */
  limit?: number;
  /** Floor for events: only ones observed after this iso timestamp. */
  since?: string;
}

export interface PublishInput {
  identifier: string;
  srcLang: string;
  tgtLang: string;
  engine: string;
  engineVersion: string;
  magnet: string;
  webseedUrl: string;
  sha256: string;
  sizeBytes: number;
  content: string;
}

export interface PublishOutcome {
  providerEventId: string;
  providerId: ProviderId;
  /** Optional per-relay or per-host detail string. */
  detail: string;
}

export interface SubsDiscoveryProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly canPublish: boolean;
  /** Fast probe — should not hit the wire if possible. The factory uses
   *  it to decide whether to register the provider in the registry. */
  available(): Promise<boolean>;
  query(filter: SubFilter): Promise<SubAnnouncement[]>;
  publish(input: PublishInput): Promise<PublishOutcome>;
}

/** Thrown by providers that don't support publishing (e.g. archive.org
 *  without S3 credentials). The service catches this and falls through
 *  to the next provider. */
export class ProviderNotPublishableError extends Error {
  constructor(public readonly providerId: ProviderId) {
    super(`provider '${providerId}' does not support publish`);
    this.name = "ProviderNotPublishableError";
  }
}
