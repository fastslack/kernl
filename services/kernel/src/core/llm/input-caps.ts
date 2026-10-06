/**
 * What a (provider, model) pair accepts as native input besides text — the
 * question chat and agents ask before turning attachments into content blocks.
 *
 * Resolved at call time, per link of a fallback chain, from the provider
 * catalog: the Anthropic API and the Claude Code CLI take images and PDFs; an
 * OpenAI-compatible endpoint takes images when its catalog entry says so or
 * when the model's name marks it as multimodal (model-traits.ts); nobody takes
 * video yet. A provider the catalog does not know (an extension) gets text
 * only, which always works.
 */

import { getCatalogEntry } from "./provider-catalog.js";
import { classifyModel } from "./model-traits.js";

export interface InputCaps {
  vision: boolean;
  pdf: boolean;
  video: boolean;
}

export const TEXT_ONLY_CAPS: Readonly<InputCaps> = Object.freeze({ vision: false, pdf: false, video: false });

export function resolveInputCaps(provider: string, model?: string): InputCaps {
  const entry = getCatalogEntry(provider);
  if (!entry) return { ...TEXT_ONLY_CAPS };
  const declared = entry.capabilities ?? {};
  // No model named: the link runs on the provider's default — judge that one.
  const effective = model || entry.models.recommended || "";
  const byName = effective ? classifyModel(entry.slug, effective).vision === true : false;
  return {
    vision: declared.vision === true || byName,
    pdf: declared.pdf === true,
    video: declared.video === true,
  };
}
