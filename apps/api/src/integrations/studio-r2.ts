import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { presignGet, putObject, type UploadResult } from "./r2.js";

/**
 * Content Studio's R2 key namespace — built ON `r2.ts`'s exports, never
 * editing it (ARCHITECTURE.md §2/§6: "r2.ts itself is off-limits").
 */
export const studioKeys = {
  footage: (tenantId: string, assetId: string, ext: string) => `${tenantId}/studio/footage/${assetId}${ext}`,
  reference: (tenantId: string, assetId: string, ext: string) => `${tenantId}/studio/reference/${assetId}${ext}`,
  render: (tenantId: string, renderId: string) => `${tenantId}/studio/renders/${renderId}.mp4`,
  music: (tenantId: string, assetId: string, ext: string) => `${tenantId}/studio/music/${assetId}${ext}`,
};

/**
 * Download an R2 object to a local file.
 *
 * `r2.ts` exports `streamUrlToR2` (a remote URL -> R2) but nothing in the
 * other direction, and it is off-limits to edit — so this builds the reverse
 * on top of the one export that does cross the boundary either way,
 * `presignGet`, the same shape `streamUrlToR2` already uses for its own
 * fetch. Used by `jobs/media-analyze.ts` to hand the sidecar (which reads
 * local files, not R2 keys) something it can open.
 */
export async function downloadToFile(key: string, destPath: string): Promise<void> {
  const { url } = await presignGet(key);
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    throw new Error(`R2 download failed (${response.status}) for ${key}: ${detail.slice(0, 300)}`);
  }
  await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(destPath));
}

export type { UploadResult };
export { putObject };
