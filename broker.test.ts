import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL(".", import.meta.url).pathname;

let proc: ReturnType<typeof Bun.spawn> | null = null;
let tempDir = "";
let brokerUrl = "";

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${brokerUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

async function waitForBroker(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${brokerUrl}/health`);
      if (res.ok) return;
    } catch {
      // broker not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("broker did not start");
}

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "codex-threads-broker-test-"));
  const port = 18000 + Math.floor(Math.random() * 10000);
  brokerUrl = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", join(root, "broker.ts")], {
    cwd: root,
    env: {
      ...process.env,
      CODEX_THREADS_PORT: String(port),
      CODEX_THREADS_DB: join(tempDir, "broker.sqlite"),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitForBroker();
});

afterEach(async () => {
  if (proc) {
    proc.kill("SIGTERM");
    await proc.exited;
    proc = null;
  }
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

test("registers Codex peers and exposes messages for the Codex bridge", async () => {
  const peerA = await post<{ id: string }>("/register", {
    pid: process.pid,
    cwd: "/repo/a",
    git_root: "/repo",
    tty: null,
    summary: "Chat A",
    client_kind: "codex",
    thread_id: "thread-a",
  });
  const peerB = await post<{ id: string }>("/register", {
    pid: process.ppid,
    cwd: "/repo/b",
    git_root: "/repo",
    tty: null,
    summary: "Chat B",
    client_kind: "codex",
    thread_id: "thread-b",
  });

  const send = await post<{
    ok: boolean;
    conversation_id: string;
    sequence: number;
    remaining_messages: number;
  }>("/send-message", {
    from_id: peerA.id,
    to_id: peerB.id,
    text: "ping",
  });

  expect(send).toMatchObject({
    ok: true,
    sequence: 1,
    remaining_messages: 199,
  });
  expect(send.conversation_id).toHaveLength(12);

  const pending = await post<{
    messages: Array<{
      id: number;
      conversation_id: string;
      sequence: number;
      from_id: string;
      from_summary: string;
      to_id: string;
      to_thread_id: string;
      text: string;
    }>;
  }>("/bridge/pending", { limit: 10 });

  expect(pending.messages).toHaveLength(1);
  const pendingMessage = pending.messages[0]!;
  expect(pendingMessage).toMatchObject({
    conversation_id: send.conversation_id,
    sequence: 1,
    from_id: peerA.id,
    from_summary: "Chat A",
    to_id: peerB.id,
    to_thread_id: "thread-b",
    text: "ping",
  });

  await post("/bridge/mark-delivered", { id: pendingMessage.id });
  const afterMark = await post<{ messages: unknown[] }>("/bridge/pending", { limit: 10 });
  expect(afterMark.messages).toHaveLength(0);
});

test("stops a conversation after 200 messages", async () => {
  const peerA = await post<{ id: string }>("/register", {
    pid: process.pid,
    cwd: "/repo/a",
    git_root: "/repo",
    tty: null,
    summary: "Chat A",
    client_kind: "codex",
    thread_id: "thread-a",
  });
  const peerB = await post<{ id: string }>("/register", {
    pid: process.ppid,
    cwd: "/repo/b",
    git_root: "/repo",
    tty: null,
    summary: "Chat B",
    client_kind: "codex",
    thread_id: "thread-b",
  });

  const first = await post<{ conversation_id: string }>("/send-message", {
    from_id: peerA.id,
    to_id: peerB.id,
    text: "message 1",
  });

  for (let i = 2; i <= 200; i++) {
    const result = await post<{ ok: boolean; sequence: number }>("/send-message", {
      from_id: i % 2 === 0 ? peerB.id : peerA.id,
      to_id: i % 2 === 0 ? peerA.id : peerB.id,
      text: `message ${i}`,
      conversation_id: first.conversation_id,
    });
    expect(result.ok).toBe(true);
    expect(result.sequence).toBe(i);
  }

  const capped = await post<{ ok: boolean; error: string }>("/send-message", {
    from_id: peerA.id,
    to_id: peerB.id,
    text: "message 201",
    conversation_id: first.conversation_id,
  });

  expect(capped).toEqual({
    ok: false,
    error: "Conversation reached the 100 exchange limit",
  });
});

test("keeps a stable peer id for repeated Codex registrations of the same thread", async () => {
  const primary = await post<{ id: string }>("/register", {
    pid: process.pid,
    cwd: "/repo/primary",
    git_root: "/repo",
    tty: null,
    summary: "Primary Codex session",
    client_kind: "codex",
    thread_id: "stable-thread",
  });

  const transient = await post<{ id: string }>("/register", {
    pid: process.ppid,
    cwd: "/repo/transient",
    git_root: "/repo",
    tty: null,
    summary: "Transient resume",
    client_kind: "codex",
    thread_id: "stable-thread",
  });

  expect(transient.id).toBe(primary.id);

  await post("/unregister", { id: transient.id, pid: process.ppid });
  const afterTransientExit = await post<Array<{ id: string; pid: number; thread_id: string }>>(
    "/list-peers",
    {
      scope: "machine",
      cwd: "/",
      git_root: null,
    }
  );

  const stablePeer = afterTransientExit.find((peer) => peer.id === primary.id);
  expect(stablePeer).toMatchObject({
    id: primary.id,
    pid: process.pid,
    thread_id: "stable-thread",
  });

  await post("/unregister", { id: primary.id, pid: process.pid });
  const afterPrimaryExit = await post<Array<{ id: string }>>("/list-peers", {
    scope: "machine",
    cwd: "/",
    git_root: null,
  });

  expect(afterPrimaryExit.some((peer) => peer.id === primary.id)).toBe(false);
});
