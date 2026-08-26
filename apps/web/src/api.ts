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

export type ClaimCounts = {
  proposed: number;
  approved: number;
  rejected: number;
  edited: number;
  superseded: number;
  total: number;
};

export type ConfidenceBand = "high" | "medium" | "low";

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

export type ClaimStatus = "proposed" | "approved" | "rejected" | "edited" | "superseded";

export type Claim = {
  id: string;
  type: ClaimType;
  type_label: string;
  text: string;
  original_text: string;
  confidence: number;
  confidence_band: ConfidenceBand;
  status: ClaimStatus;
  /** Set when this claim is a reviewer's rewrite of an earlier one. */
  edited_from: string | null;
  created_at: string;
  evidence: Evidence;
  meeting: { id: string; title: string | null; meeting_url: string; started_at: string | null };
};

export type ReviewAction = "approve" | "reject" | "edit_approve" | "undo";

/** One row of the append-only audit log behind the gate. */
export type ReviewDecision = {
  id: string;
  action: ReviewAction;
  reviewer: string;
  at: string;
  note: string | null;
  previous_text: string | null;
  edited_text: string | null;
  result_claim_id: string | null;
  claim: { id: string; type: ClaimType; type_label: string; text: string; meeting_id: string };
};

export type DecidedClaim = {
  id: string;
  type: ClaimType;
  status: ClaimStatus;
  text: string;
  confidence: number;
  edited_from: string | null;
  decided_at: string | null;
};

export type BulkApproveResult = {
  approved: DecidedClaim[];
  errors: Array<{ claim_id: string; code: string; message: string }>;
  approved_count: number;
  error_count: number;
};

/** Which call a claim came from — the chip under every line of the document. */
export type ClaimSource = {
  meeting_id: string;
  meeting_title: string | null;
  meeting_date: string | null;
};

/** Which call a whole version was merged from. */
export type SourceMeeting = { id: string; title: string | null; date: string | null };

export type BriefClaim = {
  claim_id: string;
  type: ClaimType;
  type_label: string;
  text: string;
  confidence: number;
  introduced_in_version: number;
  meeting_id: string;
  source: ClaimSource | null;
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
  counts: { added: number; removed: number; edited: number };
  total: number;
  source_meeting: SourceMeeting | null;
};

export type BriefVersion = {
  version: number | null;
  created_at?: string;
  created_by?: string;
  note?: string | null;
  total: number;
  source_meeting: SourceMeeting | null;
  claims_by_type: Array<{ type: ClaimType; label: string; claims: BriefClaim[] }>;
};

export type BriefEdit = {
  claim_id: string;
  type: ClaimType;
  type_label: string;
  from: string;
  to: string;
  source: SourceMeeting | null;
};

export type BriefDiff = {
  from: number;
  to: number;
  added: BriefClaim[];
  removed: BriefClaim[];
  edited: BriefEdit[];
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
