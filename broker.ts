#!/usr/bin/env bun
/**
 * codex-threads broker daemon
 *
 * A singleton HTTP server on localhost:7899 backed by SQLite.
 * Tracks all registered local peers and routes messages between them.
 *
 * Auto-launched by the MCP server if not already running.
 * Run directly: bun broker.ts
 */

import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import type {
  BridgeMarkDeliveredRequest,
  BridgePendingRequest,
  BridgePendingResponse,
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  ListPeersRequest,
  SendMessageRequest,
  SendMessageResponse,
  PollMessagesRequest,
  PollMessagesResponse,
  Peer,
  Message,
} from "./shared/types.ts";

const PORT = parseInt(
  process.env.CODEX_THREADS_PORT ?? process.env.CLAUDE_PEERS_PORT ?? "7899",
  10
);
const DB_PATH =
  process.env.CODEX_THREADS_DB ??
  process.env.CLAUDE_PEERS_DB ??
  `${process.env.HOME}/.codex-threads.db`;
const MAX_CONVERSATION_MESSAGES = 200;

// --- Database setup ---

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

db.run(`
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    git_root TEXT,
    tty TEXT,
    summary TEXT NOT NULL DEFAULT '',
    client_kind TEXT NOT NULL DEFAULT 'claude',
    thread_id TEXT,
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    bridge_delivered INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (from_id) REFERENCES peers(id),
    FOREIGN KEY (to_id) REFERENCES peers(id)
  )
`);

function ensureColumn(table: string, column: string, definition: string) {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((entry) => entry.name === column)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn("peers", "client_kind", "TEXT NOT NULL DEFAULT 'claude'");
ensureColumn("peers", "thread_id", "TEXT");
ensureColumn("messages", "conversation_id", "TEXT NOT NULL DEFAULT ''");
ensureColumn("messages", "sequence", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("messages", "bridge_delivered", "INTEGER NOT NULL DEFAULT 0");

// Clean up stale peers (PIDs that no longer exist) on startup
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanStalePeers() {
  const peers = db.query("SELECT id, pid FROM peers").all() as { id: string; pid: number }[];
  for (const peer of peers) {
    if (!isProcessAlive(peer.pid)) {
      // Process doesn't exist, remove it
      db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [peer.id]);
    }
  }
}

cleanStalePeers();

// Periodically clean stale peers (every 30s)
setInterval(cleanStalePeers, 30_000);

// --- Prepared statements ---

const insertPeer = db.prepare(`
  INSERT INTO peers (
    id, pid, cwd, git_root, tty, summary, client_kind, thread_id, registered_at, last_seen
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateLastSeen = db.prepare(`
  UPDATE peers SET last_seen = ? WHERE id = ?
`);

const updateSummary = db.prepare(`
  UPDATE peers SET summary = ? WHERE id = ?
`);

const deletePeer = db.prepare(`
  DELETE FROM peers WHERE id = ?
`);

const selectPeerById = db.prepare(`
  SELECT id, pid FROM peers WHERE id = ?
`);

const selectAllPeers = db.prepare(`
  SELECT * FROM peers
`);

const selectPeersByDirectory = db.prepare(`
  SELECT * FROM peers WHERE cwd = ?
`);

const selectPeersByGitRoot = db.prepare(`
  SELECT * FROM peers WHERE git_root = ?
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (
    conversation_id, sequence, from_id, to_id, text, sent_at, delivered, bridge_delivered
  )
  VALUES (?, ?, ?, ?, ?, ?, 0, 0)
`);

const selectUndelivered = db.prepare(`
  SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC
`);

const markDelivered = db.prepare(`
  UPDATE messages SET delivered = 1 WHERE id = ?
`);

const countConversationMessages = db.prepare(`
  SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?
`);

const selectBridgePending = db.prepare(`
  SELECT
    messages.*,
    source.summary AS from_summary,
    source.cwd AS from_cwd,
    source.thread_id AS from_thread_id,
    target.summary AS to_summary,
    target.cwd AS to_cwd,
    target.thread_id AS to_thread_id
  FROM messages
  JOIN peers AS source ON source.id = messages.from_id
  JOIN peers AS target ON target.id = messages.to_id
  WHERE messages.bridge_delivered = 0
    AND target.client_kind = 'codex'
    AND target.thread_id IS NOT NULL
    AND target.thread_id != ''
  ORDER BY messages.id ASC
  LIMIT ?
`);

const markBridgeDelivered = db.prepare(`
  UPDATE messages SET bridge_delivered = 1 WHERE id = ?
`);

// --- Generate peer ID ---

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function generateConversationId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 12; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function stableCodexPeerId(threadId: string): string {
  return createHash("sha256").update(threadId).digest("hex").slice(0, 8);
}

// --- Request handlers ---

function handleRegister(body: RegisterRequest): RegisterResponse {
  const isCodexThread = body.client_kind === "codex" && Boolean(body.thread_id);
  const id = isCodexThread ? stableCodexPeerId(body.thread_id!) : generateId();
  const now = new Date().toISOString();

  // Remove any existing registration for this PID (re-registration)
  const existing = db.query("SELECT id FROM peers WHERE pid = ?").get(body.pid) as { id: string } | null;
  if (existing && existing.id !== id) {
    deletePeer.run(existing.id);
  }

  if (isCodexThread) {
    const existingStablePeer = selectPeerById.get(id) as { id: string; pid: number } | null;
    if (
      existingStablePeer &&
      existingStablePeer.pid !== body.pid &&
      isProcessAlive(existingStablePeer.pid)
    ) {
      updateLastSeen.run(now, id);
      return { id };
    }
    if (existingStablePeer) {
      deletePeer.run(id);
    }
  }

  insertPeer.run(
    id,
    body.pid,
    body.cwd,
    body.git_root,
    body.tty,
    body.summary,
    body.client_kind ?? "claude",
    body.thread_id ?? null,
    now,
    now
  );
  return { id };
}

function handleHeartbeat(body: HeartbeatRequest): void {
  updateLastSeen.run(new Date().toISOString(), body.id);
}

function handleSetSummary(body: SetSummaryRequest): void {
  updateSummary.run(body.summary, body.id);
}

function handleListPeers(body: ListPeersRequest): Peer[] {
  let peers: Peer[];

  switch (body.scope) {
    case "machine":
      peers = selectAllPeers.all() as Peer[];
      break;
    case "directory":
      peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      break;
    case "repo":
      if (body.git_root) {
        peers = selectPeersByGitRoot.all(body.git_root) as Peer[];
      } else {
        // No git root, fall back to directory
        peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      }
      break;
    default:
      peers = selectAllPeers.all() as Peer[];
  }

  // Exclude the requesting peer
  if (body.exclude_id) {
    peers = peers.filter((p) => p.id !== body.exclude_id);
  }

  // Verify each peer's process is still alive
  return peers.filter((p) => {
    try {
      process.kill(p.pid, 0);
      return true;
    } catch {
      // Clean up dead peer
      deletePeer.run(p.id);
      return false;
    }
  });
}

function handleSendMessage(body: SendMessageRequest): SendMessageResponse {
  // Verify target exists
  const target = db.query("SELECT id FROM peers WHERE id = ?").get(body.to_id) as { id: string } | null;
  if (!target) {
    return { ok: false, error: `Peer ${body.to_id} not found` };
  }

  const conversationId = body.conversation_id || generateConversationId();
  const countRow = countConversationMessages.get(conversationId) as { count: number };
  const count = countRow.count;
  if (count >= MAX_CONVERSATION_MESSAGES) {
    return { ok: false, error: "Conversation reached the 100 exchange limit" };
  }

  const sequence = count + 1;
  insertMessage.run(
    conversationId,
    sequence,
    body.from_id,
    body.to_id,
    body.text,
    new Date().toISOString()
  );
  return {
    ok: true,
    conversation_id: conversationId,
    sequence,
    remaining_messages: MAX_CONVERSATION_MESSAGES - sequence,
  };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const messages = selectUndelivered.all(body.id) as Message[];

  // Mark them as delivered
  for (const msg of messages) {
    markDelivered.run(msg.id);
  }

  return { messages };
}

function handleUnregister(body: { id: string; pid?: number }): void {
  if (body.pid !== undefined) {
    const existing = selectPeerById.get(body.id) as { id: string; pid: number } | null;
    if (!existing || existing.pid !== body.pid) {
      return;
    }
  }
  deletePeer.run(body.id);
}

function handleBridgePending(body: BridgePendingRequest): BridgePendingResponse {
  const limit = Math.max(1, Math.min(body.limit ?? 25, 100));
  return {
    messages: selectBridgePending.all(limit) as BridgePendingResponse["messages"],
  };
}

function handleBridgeMarkDelivered(body: BridgeMarkDeliveredRequest): void {
  markBridgeDelivered.run(body.id);
}

// --- HTTP Server ---

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method !== "POST") {
      if (path === "/health") {
        return Response.json({ status: "ok", peers: (selectAllPeers.all() as Peer[]).length });
      }
      return new Response("codex-threads broker", { status: 200 });
    }

    try {
      const body = await req.json();

      switch (path) {
        case "/register":
          return Response.json(handleRegister(body as RegisterRequest));
        case "/heartbeat":
          handleHeartbeat(body as HeartbeatRequest);
          return Response.json({ ok: true });
        case "/set-summary":
          handleSetSummary(body as SetSummaryRequest);
          return Response.json({ ok: true });
        case "/list-peers":
          return Response.json(handleListPeers(body as ListPeersRequest));
        case "/send-message":
          return Response.json(handleSendMessage(body as SendMessageRequest));
        case "/poll-messages":
          return Response.json(handlePollMessages(body as PollMessagesRequest));
        case "/bridge/pending":
          return Response.json(handleBridgePending(body as BridgePendingRequest));
        case "/bridge/mark-delivered":
          handleBridgeMarkDelivered(body as BridgeMarkDeliveredRequest);
          return Response.json({ ok: true });
        case "/unregister":
          handleUnregister(body as { id: string; pid?: number });
          return Response.json({ ok: true });
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ error: msg }, { status: 500 });
    }
  },
});

console.error(`[codex-threads broker] listening on 127.0.0.1:${PORT} (db: ${DB_PATH})`);
