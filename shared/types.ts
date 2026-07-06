// Unique ID for each local peer (generated on registration)
export type PeerId = string;

export interface Peer {
  id: PeerId;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  client_kind: "claude" | "codex" | "unknown";
  thread_id: string | null;
  registered_at: string; // ISO timestamp
  last_seen: string; // ISO timestamp
}

export interface Message {
  id: number;
  conversation_id: string;
  sequence: number;
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  sent_at: string; // ISO timestamp
  delivered: boolean;
  bridge_delivered: boolean;
}

export interface BridgePendingMessage extends Message {
  from_summary: string;
  from_cwd: string;
  from_thread_id: string | null;
  to_summary: string;
  to_cwd: string;
  to_thread_id: string;
}

// --- Broker API types ---

export interface RegisterRequest {
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  client_kind?: "claude" | "codex" | "unknown";
  thread_id?: string | null;
}

export interface RegisterResponse {
  id: PeerId;
}

export interface HeartbeatRequest {
  id: PeerId;
}

export interface SetSummaryRequest {
  id: PeerId;
  summary: string;
}

export interface ListPeersRequest {
  scope: "machine" | "directory" | "repo";
  // The requesting peer's context (used for filtering)
  cwd: string;
  git_root: string | null;
  exclude_id?: PeerId;
}

export interface SendMessageRequest {
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  conversation_id?: string;
}

export interface SendMessageResponse {
  ok: boolean;
  error?: string;
  conversation_id?: string;
  sequence?: number;
  remaining_messages?: number;
}

export interface PollMessagesRequest {
  id: PeerId;
}

export interface PollMessagesResponse {
  messages: Message[];
}

export interface BridgePendingRequest {
  limit?: number;
}

export interface BridgePendingResponse {
  messages: BridgePendingMessage[];
}

export interface BridgeMarkDeliveredRequest {
  id: number;
}
