import crypto from "node:crypto";
import { Readable, Transform } from "node:stream";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../env.js";

/**
 * Cloudflare R2 is S3-compatible. Region must literally be "auto" — the SDK
 * requires the field, R2 ignores the value.
 */
export const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  },
});

/**
 * Object keys. Artifacts are immutable once written, so the key is derived
 * entirely from identity — re-running an ingest job overwrites byte-identical
 * content rather than accumulating duplicates.
 */
export const keys = {
  recordingAudio: (tenantId: string, meetingId: string) =>
    `${tenantId}/meetings/${meetingId}/recording.mp3`,
  recordingVideo: (tenantId: string, meetingId: string) =>
    `${tenantId}/meetings/${meetingId}/recording.mp4`,
  transcriptJson: (tenantId: string, meetingId: string) =>
    `${tenantId}/meetings/${meetingId}/transcript.json`,
  meetingPrefix: (tenantId: string, meetingId: string) => `${tenantId}/meetings/${meetingId}/`,
};

export type UploadResult = { key: string; bytes: number; checksum: string; contentType: string };

/** Counts bytes and hashes them as they flow past. Nothing is retained. */
function meter() {
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  const stream = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      bytes += chunk.length;
      cb(null, chunk);
    },
  });
  return { stream, done: () => ({ bytes, checksum: `sha256:${hash.digest("hex")}` }) };
}

/**
 * Stream a remote URL straight into R2.
 *
 * Recall retains media for roughly seven days, so this runs in the completion
 * handler and never lazily. The body is piped — a two-hour recording is never
 * materialised in memory. `Upload` switches to multipart automatically past
 * the part size, which covers the >100MB case.
 */
export async function streamUrlToR2(args: {
  url: string;
  key: string;
  contentType: string;
}): Promise<UploadResult> {
  const response = await fetch(args.url);
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Download failed (${response.status}) for ${args.key}: ${detail.slice(0, 300)}`);
  }

  const { stream: gauge, done } = meter();
  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]).pipe(gauge);

  const upload = new Upload({
    client: r2,
    params: {
      Bucket: env.R2_BUCKET,
      Key: args.key,
      Body: source,
      ContentType: args.contentType,
    },
    queueSize: 4,
    partSize: 16 * 1024 * 1024,
  });

  await upload.done();
  const { bytes, checksum } = done();
  return { key: args.key, bytes, checksum, contentType: args.contentType };
}

/** For payloads we already hold in memory — the transcript JSON, kilobytes. */
export async function putObject(args: {
  key: string;
  body: Buffer | string;
  contentType: string;
}): Promise<UploadResult> {
  const buf = Buffer.isBuffer(args.body) ? args.body : Buffer.from(args.body, "utf8");
  await r2.send(
    new PutObjectCommand({
      Bucket: env.R2_BUCKET,
      Key: args.key,
      Body: buf,
      ContentType: args.contentType,
    }),
  );
  return {
    key: args.key,
    bytes: buf.byteLength,
    checksum: `sha256:${crypto.createHash("sha256").update(buf).digest("hex")}`,
    contentType: args.contentType,
  };
}

/** Presigned GET for the frontend. R2 caps expiry at 7 days; an hour is plenty. */
export async function presignGet(key: string, expiresIn = 3600): Promise<{ url: string; expiresAt: Date }> {
  const url = await getSignedUrl(r2, new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key }), {
    expiresIn,
  });
  return { url, expiresAt: new Date(Date.now() + expiresIn * 1000) };
}

export async function objectExists(key: string): Promise<boolean> {
  try {
    await r2.send(new HeadObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/** Deletion path. Called when a meeting is purged. */
export async function deleteObjects(objectKeys: string[]): Promise<void> {
  if (objectKeys.length === 0) return;
  if (objectKeys.length === 1) {
    await r2.send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET, Key: objectKeys[0]! }));
    return;
  }
  await r2.send(
    new DeleteObjectsCommand({
      Bucket: env.R2_BUCKET,
      Delete: { Objects: objectKeys.map((Key) => ({ Key })) },
    }),
  );
}
