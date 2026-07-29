/**
 * archive.org subtitle provider — read-only mode.
 *
 * archive.org items already carry user-uploaded subtitle files inside
 * their item bundle (`<id>.es.srt`, `<id>.spanish.vtt`, etc.). This
 * provider lists them by hitting the metadata API for the requested
 * `identifier` and surfacing each .srt/.vtt as a SubAnnouncement.
 *
 * Why no publish: uploading to archive.org via S3 requires per-user
 * S3-style credentials. Wiring that up needs the user to authorize the
 * kernel and is out of scope for the foundation pass. When credentials
 * are configured (stage 4b), `canPublish` flips on and `publish()`
 * pushes the .srt as an item file.
 *
 * Pagination: there is none — `metadata/<id>` returns the full file
 * list in one shot. We just filter the list to subtitle extensions.
 */

import { ProviderNotPublishableError } from "./provider.js";
import type {
  PublishInput,
  PublishOutcome,
  SubAnnouncement,
  SubFilter,
  SubsDiscoveryProvider,
} from "./provider.js";

interface ArchiveMetadataFile {
  name: string;
  size?: string | number;
  format?: string;
  // archive.org doesn't include a checksum we can use as sha256
  // consistently; sha1/md5 are the documented ones. We leave sha256
  // empty for archive_org-origin announcements and let the consumer
  // compute it after download.
  sha1?: string;
  md5?: string;
}

interface ArchiveMetadataResponse {
  metadata?: { title?: string; description?: string };
  files?: ArchiveMetadataFile[];
}

/** Subtitle extensions we recognize. */
const SUBTITLE_EXT = /\.(srt|vtt|sbv|ass|ssa)$/i;

/** Extract a probable language code from a subtitle file name. archive.org
 *  conventions:
 *    "<id>.es.srt"           → es
 *    "<id>.spanish.srt"      → es (mapped)
 *    "<id>_subs_pt-br.vtt"   → pt
 *    "<id>.srt"              → "" (unknown — defaults to whatever the title's `language` is)
 */
function inferLang(filename: string): string {
  const stripped = filename.replace(SUBTITLE_EXT, "");
  // last dot-segment or underscore-segment is the lang token, normalised
  const tokens = stripped.split(/[._-]/).filter(Boolean);
  const last = tokens[tokens.length - 1]?.toLowerCase() ?? "";
  if (/^[a-z]{2}(-[a-z]{2})?$/.test(last)) return last.slice(0, 2);
  const named: Record<string, string> = {
    spanish: "es", english: "en", french: "fr", german: "de",
    italian: "it", portuguese: "pt", japanese: "ja", chinese: "zh",
    russian: "ru", arabic: "ar", korean: "ko", castellano: "es",
    espanol: "es", "español": "es",
  };
  return named[last] ?? "";
}

const REQUEST_TIMEOUT_MS = 8000;

async function fetchMetadata(identifier: string): Promise<ArchiveMetadataResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(`https://archive.org/metadata/${encodeURIComponent(identifier)}`, {
      headers: { "user-agent": "Kernl/cinema-subs-discovery" },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!r.ok) {
      throw new Error(`archive.org metadata ${r.status} ${r.statusText} for ${identifier}`);
    }
    return (await r.json()) as ArchiveMetadataResponse;
  } finally {
    clearTimeout(timer);
  }
}

export interface ArchiveSubsProviderConfig {
  /** When true (and S3 credentials present), enables uploading .srt as
   *  an additional file on the item. Stage 4b feature — toggle off here. */
  enableUploads?: boolean;
}

export class ArchiveSubsProvider implements SubsDiscoveryProvider {
  readonly id = "archive_org" as const;
  readonly label = "archive.org";
  readonly canPublish: boolean;

  constructor(_config: ArchiveSubsProviderConfig = {}) {
    // Stage 4a — read-only.
    this.canPublish = false;
  }

  async available(): Promise<boolean> {
    // archive.org's metadata API is rock-solid; treat as always-on.
    // The first real call will surface a transport error if it's down.
    return true;
  }

  async query(filter: SubFilter): Promise<SubAnnouncement[]> {
    if (!filter.identifier) {
      // archive.org doesn't expose a "list every sub on the network"
      // index — the metadata API is per-item. Returning empty for
      // global queries is the right answer.
      return [];
    }

    let body: ArchiveMetadataResponse;
    try {
      body = await fetchMetadata(filter.identifier);
    } catch {
      // Don't propagate — one provider failing shouldn't break the
      // whole multi-provider query. The caller logs at registry level.
      return [];
    }

    const files = body.files ?? [];
    const seenAt = new Date().toISOString();   // archive.org doesn't expose
                                                // per-file upload timestamps
                                                // in the bare metadata.
    const out: SubAnnouncement[] = [];
    for (const f of files) {
      const name = String(f.name ?? "");
      if (!SUBTITLE_EXT.test(name)) continue;
      // skip auto-generated derivatives (whisper/vtt) the kernel itself
      // may have published — those are duplicate paths; keep only the
      // user-curated .srt/.vtt files. archive.org marks derivatives via
      // format strings like "Web Video Text Tracks" without a parent flag,
      // so the only reliable filter is the underscore prefix used for
      // archive.org's internal _files.xml, _meta.xml, etc.
      if (name.startsWith("__ia_") || name.startsWith("_")) continue;

      const lang = inferLang(name);
      if (filter.tgtLang && filter.tgtLang.length > 0 && lang && !filter.tgtLang.includes(lang)) {
        continue;
      }
      const sizeBytes = typeof f.size === "string" ? parseInt(f.size, 10) || 0
                       : typeof f.size === "number" ? f.size
                       : 0;
      out.push({
        providerEventId: name,                 // unique per item
        providerId: this.id,
        identifier: filter.identifier,
        srcLang: "",                            // archive.org doesn't model src vs tgt — only tgt
        tgtLang: lang,                          // empty if we couldn't infer
        engine: "human",                        // assume user-uploaded; auto-generated subs are usually inside derivatives
        engineVersion: "",
        signerPubkey: "",                       // archive.org has no per-file signer
        magnet: "",                             // The item's master torrent covers the file but
                                                // there's no per-file magnet; consumers fetch via webseed.
        webseedUrl: `https://archive.org/download/${encodeURIComponent(filter.identifier)}/${encodeURIComponent(name)}`,
        sha256: "",                             // archive.org publishes sha1/md5, not sha256
        sizeBytes,
        content: name,
        observedAt: seenAt,
      });
    }
    return out;
  }

  async publish(_input: PublishInput): Promise<PublishOutcome> {
    throw new ProviderNotPublishableError(this.id);
  }
}
