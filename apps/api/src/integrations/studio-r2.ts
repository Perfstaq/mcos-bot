import crypto from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Upload } from "@aws-sdk/lib-storage";
import { env } from "../env.js";
import { deleteObjects, presignGet, putObject, r2, type UploadResult } from "./r2.js";

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

/**
 * Stream a LOCAL file into R2.
 *
 * The third direction `r2.ts` does not have: it covers remote URL → R2
 * (`streamUrlToR2`) and in-memory payload → R2 (`putObject`, explicitly "for
 * payloads we already hold in memory — the transcript JSON, kilobytes"), and
 * it is off-limits to edit. A finished render is 30MB+, so `putObject` is the
 * wrong tool — it buffers the whole body, and at `render.submit`'s concurrency
 * of 4 that is four MP4s resident at once for no reason.
 *
 * So this composes r2.ts's exported client with `Upload` exactly the way
 * `streamUrlToR2` does, including its metering transform, and gets multipart
 * for free past the part size. Consuming the exports, never editing the file —
 * the posture ARCHITECTURE §6 prescribes for this module.
 */
export async function uploadFileToR2(args: {
  filePath: string;
  key: string;
  contentType: string;
}): Promise<UploadResult> {
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  const gauge = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      bytes += chunk.length;
      cb(null, chunk);
    },
  });

  const upload = new Upload({
    client: r2,
    params: {
      Bucket: env.R2_BUCKET,
      Key: args.key,
      Body: createReadStream(args.filePath).pipe(gauge),
      ContentType: args.contentType,
    },
    queueSize: 4,
    partSize: 16 * 1024 * 1024,
  });

  await upload.done();
  return { key: args.key, bytes, checksum: `sha256:${hash.digest("hex")}`, contentType: args.contentType };
}

export type { UploadResult };
export { presignGet, putObject, deleteObjects };
