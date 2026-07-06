import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Peer } from "./shared/types.ts";

const root = new URL(".", import.meta.url).pathname;

let serverProc: ReturnType<typeof Bun.spawn> | null = null;
let tempDir = "";
let brokerUrl = "";
let port = 0;

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

async function waitForCodexPeer(): Promise<Peer> {
  for (let i = 0; i < 80; i++) {
    try {
      const peers = await post<Peer[]>("/list-peers", {
        scope: "machine",
        cwd: "/",
        git_root: null,
      });
      const peer = peers.find((entry) => entry.thread_id === "thread-from-env");
      if (peer) return peer;
    } catch {
      // broker or peer not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Codex peer did not register");
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "codex-threads-server-test-"));
  port = 28000 + Math.floor(Math.random() * 10000);
  brokerUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  if (serverProc) {
    serverProc.kill("SIGTERM");
    await serverProc.exited;
    serverProc = null;
  }
  const pids = Bun.spawnSync(["lsof", "-tiTCP:" + port, "-sTCP:LISTEN"]).stdout.toString().trim().split("\n");
  for (const pid of pids) {
    if (pid) {
      try {
        process.kill(parseInt(pid, 10), "SIGTERM");
      } catch {
        // process already exited
      }
    }
  }
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

test("registers Codex thread metadata from CODEX_THREAD_ID", async () => {
  serverProc = Bun.spawn(["bun", join(root, "server.ts")], {
    cwd: root,
    env: {
      ...process.env,
      CODEX_THREADS_PORT: String(port),
      CODEX_THREADS_DB: join(tempDir, "broker.sqlite"),
      CODEX_THREAD_ID: "thread-from-env",
      CODEX_THREADS_AUTOSTART_BRIDGE: "0",
      OPENAI_API_KEY: "",
    },
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  });

  const peer = await waitForCodexPeer();

  expect(peer.client_kind).toBe("codex");
  expect(peer.thread_id).toBe("thread-from-env");
});
