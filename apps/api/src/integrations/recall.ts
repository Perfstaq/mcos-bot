import crypto from "node:crypto";
import { env, recallBaseUrl } from "../env.js";

/* -------------------------------------------------------------------------
 * Webhook signature verification
 * ---------------------------------------------------------------------- */

/**
 * Recall signs with the Standard Webhooks HMAC scheme.
 *
 * Modern accounts send `webhook-id` / `webhook-timestamp` / `webhook-signature`
 * and are verified with the WORKSPACE verification secret. Accounts created
 * before 2025-12-15 send the legacy `svix-*` headers and verify dashboard
 * webhooks with a per-endpoint secret. Same math either way, so we accept both
 * header sets and try every configured secret.
 *
 * Rotation note: for up to 24h after rotating a secret, Recall sends multiple
 * `v1,<sig>` values in one header. Any match is a pass.
 */
const FIVE_MINUTES = 5 * 60;

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export function verifyRecallSignature(args: {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  secrets?: string[];
  /** Injectable for deterministic tests. Seconds since epoch. */
  now?: number;
}): VerifyResult {
  const header = (name: string): string | undefined => {
    const v = args.headers[name] ?? args.headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };

  const msgId = header("webhook-id") ?? header("svix-id");
  const msgTimestamp = header("webhook-timestamp") ?? header("svix-timestamp");
  const msgSignature = header("webhook-signature") ?? header("svix-signature");

  if (!msgId || !msgTimestamp || !msgSignature) {
    return { ok: false, reason: "missing signature headers" };
  }

  // Replay window. A signature is only valid near the time it was made.
  const ts = Number.parseInt(msgTimestamp, 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: "malformed timestamp" };
  const now = args.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > FIVE_MINUTES) return { ok: false, reason: "timestamp outside tolerance" };

  const secrets = (args.secrets ?? configuredSecrets()).filter(Boolean);
  if (secrets.length === 0) return { ok: false, reason: "no webhook secret configured" };

  const signed = `${msgId}.${msgTimestamp}.${args.rawBody}`;
  const presented = msgSignature
    .split(" ")
    .map((part) => part.split(","))
    .filter(([version]) => version === "v1")
    .map(([, sig]) => sig)
    .filter((s): s is string => Boolean(s));

  if (presented.length === 0) return { ok: false, reason: "no v1 signature present" };

  for (const secret of secrets) {
    const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
    const expected = crypto.createHmac("sha256", key).update(signed).digest();
    for (const candidate of presented) {
      const given = Buffer.from(candidate, "base64");
      if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) {
        return { ok: true };
      }
    }
  }

  return { ok: false, reason: "no matching signature" };
}

function configuredSecrets(): string[] {
  // Workspace secret first: it is the one modern accounts use for everything.
  return [env.RECALL_WEBHOOK_SECRET, env.RECALL_SVIX_WEBHOOK_SECRET].filter(
    (s): s is string => Boolean(s),
  );
}

/* -------------------------------------------------------------------------
 * HTTP client
 * ---------------------------------------------------------------------- */

export class RecallError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "RecallError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Recall documents 429/503/507 as routine and requires callers to honour
 * `Retry-After`. Every request in this file goes through here.
 *   429 → wait Retry-After
 *   503 → server briefly unavailable, wait 10s
 *   507 → ad-hoc bot pool drained, wait 30s
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  maxAttempts = 6,
): Promise<Response> {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetch(url, init);
    lastStatus = response.status;

    let waitSeconds: number | null = null;
    switch (response.status) {
      case 429:
        waitSeconds = Number.parseInt(response.headers.get("Retry-After") ?? "5", 10) || 5;
        break;
      case 503:
        waitSeconds = 10;
        break;
      case 507:
        waitSeconds = 30;
        break;
    }

    if (waitSeconds === null) return response;
    if (attempt === maxAttempts) return response;
    await sleep(1000 * (waitSeconds + Math.ceil(Math.random() * 5)));
  }
  throw new RecallError(`Exhausted retries for ${url}`, lastStatus, "");
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = `${recallBaseUrl}${path}`;
  const response = await fetchWithRetry(url, {
    ...init,
    headers: {
      Authorization: `Token ${env.RECALLAI_API_KEY}`,
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new RecallError(`Recall ${init.method ?? "GET"} ${path} failed`, response.status, body);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/* -------------------------------------------------------------------------
 * Response shapes (only the fields we use — see docs.recall.ai for the rest)
 * ---------------------------------------------------------------------- */

export type RecallArtifactStatus = {
  code: string;
  sub_code: string | null;
  updated_at: string;
};

export type RecallArtifactShortcut = {
  id: string;
  status?: RecallArtifactStatus;
  data?: { download_url?: string | null; provider_data_download_url?: string | null };
} | null;

export type RecallRecording = {
  id: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  expires_at: string | null;
  status?: RecallArtifactStatus;
  media_shortcuts?: {
    audio_mixed?: RecallArtifactShortcut;
    video_mixed?: RecallArtifactShortcut;
    transcript?: RecallArtifactShortcut;
    meeting_metadata?: RecallArtifactShortcut;
  };
};

export type RecallBot = {
  id: string;
  meeting_url: string | Record<string, unknown>;
  bot_name?: string;
  join_at?: string | null;
  status_changes?: Array<{ code: string; message: string | null; created_at: string; sub_code: string | null }>;
  recordings?: RecallRecording[];
  metadata?: Record<string, string>;
};

export type RecallTranscript = {
  id: string;
  recording?: { id: string };
  status?: RecallArtifactStatus;
  data?: { download_url?: string | null; provider_data_download_url?: string | null };
};

/** The downloaded transcript JSON — https://docs.recall.ai/docs/download-schemas */
export type RecallTranscriptParticipant = {
  id: number;
  name: string | null;
  is_host: boolean | null;
  platform: string | null;
  extra_data: unknown;
  email?: string | null;
};

export type RecallTranscriptWord = {
  text: string;
  start_timestamp: { absolute: string | null; relative: number } | null;
  end_timestamp: { absolute: string | null; relative: number } | null;
};

export type RecallTranscriptEntry = {
  participant: RecallTranscriptParticipant;
  language_code?: string;
  words: RecallTranscriptWord[];
};

/* -------------------------------------------------------------------------
 * Operations
 * ---------------------------------------------------------------------- */

/**
 * Bot creation is always modelled as a scheduling operation, even when the bot
 * should join right now — `join_at` goes through the same path either way, so
 * scheduled bots need no second code path.
 *
 * NOTE: no transcript provider is configured here. `recallai_async` is a
 * post-recording job (POST /recording/{id}/create_transcript/); configuring a
 * provider at bot creation selects the REAL-TIME flow, which Milestone 1 does
 * not use.
 */
export async function createBot(args: {
  meetingUrl: string;
  joinAt?: Date | null;
  metadata?: Record<string, string>;
}): Promise<RecallBot> {
  const recordingConfig: Record<string, unknown> = {
    audio_mixed_mp3: {},
    ...(env.RECALL_CAPTURE_VIDEO ? { video_mixed_mp4: {} } : {}),
  };

  const body: Record<string, unknown> = {
    meeting_url: args.meetingUrl,
    bot_name: env.RECALL_BOT_NAME,
    recording_config: recordingConfig,
    ...(args.joinAt ? { join_at: args.joinAt.toISOString() } : {}),
    ...(args.metadata ? { metadata: args.metadata } : {}),
    ...(env.RECALL_JOIN_MESSAGE
      ? { chat: { on_bot_join: { send_to: "everyone", message: env.RECALL_JOIN_MESSAGE, pin: false } } }
      : {}),
  };

  return call<RecallBot>("/bot/", { method: "POST", body: JSON.stringify(body) });
}

export async function getBot(botId: string): Promise<RecallBot> {
  return call<RecallBot>(`/bot/${botId}/`);
}

export async function getRecording(recordingId: string): Promise<RecallRecording> {
  return call<RecallRecording>(`/recording/${recordingId}/`);
}

export async function getTranscript(transcriptId: string): Promise<RecallTranscript> {
  return call<RecallTranscript>(`/transcript/${transcriptId}/`);
}

/** Kick off post-meeting transcription. Called from the recording.done handler. */
export async function createAsyncTranscript(recordingId: string): Promise<RecallTranscript> {
  return call<RecallTranscript>(`/recording/${recordingId}/create_transcript/`, {
    method: "POST",
    body: JSON.stringify({
      provider: { recallai_async: { language_code: "auto" } },
      diarization: { use_separate_streams_when_available: true },
    }),
  });
}

export async function deleteBotMedia(botId: string): Promise<void> {
  await call<void>(`/bot/${botId}/delete_media/`, { method: "POST" });
}
