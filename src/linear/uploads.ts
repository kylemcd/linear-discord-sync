import type { APIAttachment } from "discord-api-types/v10";
import { errorMessage, log } from "../log";
import type { LinearClient } from "./client";

/** Larger attachments are linked instead of copied, to keep Worker memory low. */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export interface UploadedAttachment {
  filename: string;
  url: string;
  isImage: boolean;
  /** false = still the Discord CDN URL, which expires. */
  copied: boolean;
}

/**
 * Copy Discord attachments into Linear storage. Discord CDN links expire, so
 * copying keeps screenshots readable in Linear. Falls back to the Discord URL.
 */
export async function copyAttachmentsToLinear(
  linear: LinearClient,
  attachments: APIAttachment[],
  context: { discordThreadId: string },
): Promise<UploadedAttachment[]> {
  const out: UploadedAttachment[] = [];
  for (const a of attachments) {
    const contentType = a.content_type ?? "application/octet-stream";
    const isImage = contentType.startsWith("image/");
    if (a.size > MAX_UPLOAD_BYTES) {
      out.push({ filename: a.filename, url: a.url, isImage, copied: false });
      continue;
    }
    try {
      const source = await fetch(a.url);
      if (!source.ok) throw new Error(`download ${source.status}`);
      // Buffer rather than stream: the signed upload URL needs a Content-Length.
      const bytes = await source.arrayBuffer();
      const target = await linear.prepareUpload({ filename: a.filename, contentType, size: bytes.byteLength });
      const headers = new Headers({ "Content-Type": contentType, "Cache-Control": "public, max-age=31536000" });
      for (const h of target.headers) headers.set(h.key, h.value);
      const put = await fetch(target.uploadUrl, { method: "PUT", headers, body: bytes });
      if (!put.ok) throw new Error(`upload ${put.status}`);
      out.push({ filename: a.filename, url: target.assetUrl, isImage, copied: true });
    } catch (err) {
      log.warn({
        operation: "attachment_upload",
        result: "error",
        discordThreadId: context.discordThreadId,
        filename: a.filename,
        error: errorMessage(err),
      });
      out.push({ filename: a.filename, url: a.url, isImage, copied: false });
    }
  }
  return out;
}
