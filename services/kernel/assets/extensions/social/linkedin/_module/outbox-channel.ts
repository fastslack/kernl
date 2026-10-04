/**
 * The `linkedin_post` outbox channel (kernel projects module). An office
 * proposes a post as a draft; once the operator approves it, the outbox calls
 * send() here. account_ref: `linkedin:<account_id>`.
 */
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { OutboxChannelHandler } from "@kernl/extension-sdk";
import type { LinkedInService } from "./service.js";

interface LinkedInPayload { text: string; image_path?: string; article_url?: string; article_title?: string }

const accountIdOf = (ref: string) => (ref.startsWith("linkedin:") ? ref.slice("linkedin:".length) : "");

export function linkedinChannel(deps: { service: () => LinkedInService | null; projectAssetsRoot: string }): OutboxChannelHandler {
  const problem = (p: LinkedInPayload, ref: string): string | null => {
    const svc = deps.service();
    if (!svc) return "LinkedIn no está disponible";
    const text = p?.text ?? "";
    if (!text.trim()) return "Falta el texto del post";
    if (text.length > 3000) return "El post supera los 3000 caracteres";
    const account = svc.getAccount(accountIdOf(ref));
    if (!account) return `Cuenta de LinkedIn ${accountIdOf(ref) || ref} no encontrada`;
    if (account.status !== "active") return "La cuenta de LinkedIn no está activa";
    if (p.image_path) {
      // Only images the project keeps under data/projects/<slug>/assets/.
      const abs = resolve(p.image_path);
      const root = resolve(deps.projectAssetsRoot) + sep;
      if (!abs.startsWith(root) || !abs.includes(`${sep}assets${sep}`)) return "La imagen tiene que estar en la carpeta assets del proyecto";
      if (!existsSync(abs)) return "La imagen no existe";
    }
    return null;
  };

  return {
    validate: (payload, ref) => {
      const err = problem(payload as LinkedInPayload, ref);
      return err ? { ok: false, error: err } : { ok: true };
    },
    preview: (payload) => {
      const p = payload as LinkedInPayload;
      const meta: Record<string, string> = {};
      if (p.image_path) meta.Imagen = p.image_path.split(/[\\/]/).pop() ?? p.image_path;
      if (p.article_url) meta.Link = p.article_url;
      return { title: "", body: p.text, ...(Object.keys(meta).length ? { meta } : {}) };
    },
    send: async (payload, ref) => {
      const p = payload as LinkedInPayload;
      const err = problem(p, ref);
      if (err) throw new Error(err);
      const svc = deps.service()!;
      const account_id = accountIdOf(ref);
      try {
        const post = p.image_path
          ? await svc.createImagePost({ account_id, text: p.text, image_path: resolve(p.image_path) })
          : await svc.createTextPost({ account_id, text: p.text, article_url: p.article_url, article_title: p.article_title });
        return { ref: post.post_urn || post.id };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/token|401|expired|unauthori[sz]ed/i.test(msg)) throw new Error("La cuenta de LinkedIn necesita reconectarse");
        throw e;
      }
    },
  };
}

/** What /api/linkedin/accounts returns: enough to pick an account, never its tokens. */
export function linkedinAccountsView(rows: Array<{ id: string; display_name: string; status: string; token_expires_at: string | null }>) {
  return rows.map(({ id, display_name, status, token_expires_at }) => ({ id, display_name, status, token_expires_at }));
}
