/**
 * `attachment_ids` as it arrives in a request body: validate the shape and
 * bind the ids, so the caller stores only ids that point at ready files.
 */

import { HttpError } from "../../sdk/http-error.js";
import { getAttachmentService } from "./index.js";
import type { AttachmentRecord } from "./types.js";

/** Absent → none. Not an array of strings → 400. Unknown / unready ids → 400 from the bind. */
export function bindAttachmentIdsArg(value: unknown): AttachmentRecord[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((x) => typeof x === "string")) {
    throw new HttpError(400, "attachment_ids must be an array of attachment ids");
  }
  if (value.length === 0) return [];
  const svc = getAttachmentService();
  if (!svc) throw new HttpError(400, "Attachments are not available in this kernel");
  return svc.bind(value as string[]);
}
