const BASE = "/api/v1";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const err = body?.error ?? {};
    throw new ApiError(response.status, err.code ?? "error", err.message ?? response.statusText);
  }
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  del: (path: string) => request<void>(path, { method: "DELETE" }),
};

/* ------------------------------------------------------------------ types */

export type MeetingStatus =
  | "draft" | "bot_scheduled" | "bot_joined" | "recording" | "call_ended"
  | "media_processing" | "transcript_ready" | "extracting" | "in_review"
  | "merged" | "failed";

export type ClaimType =
  | "positioning_statement" | "icp_fact" | "pain_point" | "objection"
  | "messaging_decision" | "competitor_mention" | "proof_point";

export type ClaimCounts = { proposed: number; approved: number; rejected: number; edited: number; total: number };

export type Meeting = {
  id: string;
  title: string | null;
  meeting_url: string;
  join_at: string | null;
  status: MeetingStatus;
  failure_reason: string | null;
  failed_stage: string | null;
  platform: string | null;
  started_at: string | null;
  created_at: string;
  claim_counts: ClaimCounts;
  artifacts: Array<{ kind: string; bytes: number; purged: boolean }>;
  transcript: { segmentCount: number; durationMs: number } | null;
};

export type Transition = { from: MeetingStatus | null; to: MeetingStatus; reason: string | null; at: string };

export type MeetingDetail = Meeting & {
  transitions: Transition[];
  transcript: { segmentCount: number; wordCount: number; durationMs: number; languageCode: string | null } | null;
  extraction: {
    status: string;
    model: string;
    chunks: number;
    proposed: number;
    dropped: number;
    duplicates: number;
    persisted: number;
    error: string | null;
  } | null;
};

export type Evidence = {
  verbatim_quote: string;
  speaker: string;
  timestamp_ms: number;
  timestamp_label: string;
  segments: Array<{ id: string; idx: number; speaker: string; start_ms: number; text: string }>;
};

export type Claim = {
  id: string;
  type: ClaimType;
  type_label: string;
  text: string;
  original_text: string;
  confidence: number;
  status: "proposed" | "approved" | "rejected" | "edited";
  created_at: string;
  evidence: Evidence;
  meeting: { id: string; title: string | null; meeting_url: string; started_at: string | null };
};

export type BriefClaim = {
  claim_id: string;
  type: ClaimType;
  type_label: string;
  text: string;
  confidence: number;
  introduced_in_version: number;
  meeting_id: string;
  evidence: { verbatim_quote: string; speaker: string; timestamp_label: string; redacted: boolean };
};

export type BriefVersionSummary = {
  version: number;
  created_at: string;
  created_by: string;
  note: string | null;
  added: number;
  removed: number;
  edited: number;
  total: number;
};

export type BriefVersion = {
  version: number | null;
  created_at?: string;
  created_by?: string;
  note?: string | null;
  total: number;
  claims_by_type: Array<{ type: ClaimType; label: string; claims: BriefClaim[] }>;
};

export type BriefDiff = {
  from: number;
  to: number;
  added: BriefClaim[];
  removed: BriefClaim[];
  edited: Array<{ claim_id: string; type: ClaimType; type_label: string; before: string; after: string }>;
  unchanged: number;
};

export const CLAIM_TYPE_ORDER: ClaimType[] = [
  "positioning_statement",
  "icp_fact",
  "pain_point",
  "objection",
  "messaging_decision",
  "competitor_mention",
  "proof_point",
];

export const CLAIM_TYPE_LABEL: Record<ClaimType, string> = {
  positioning_statement: "Positioning statement",
  icp_fact: "ICP fact",
  pain_point: "Pain point",
  objection: "Objection",
  messaging_decision: "Messaging decision",
  competitor_mention: "Competitor mention",
  proof_point: "Proof point",
};
