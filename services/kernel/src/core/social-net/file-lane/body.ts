import type { IncomingMessage } from "node:http";
import { HttpError } from "../../http-server.js";

/** The raw request body, refusing anything over `max` bytes with a 413. */
export function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) { reject(new HttpError(413, "body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
