#!/usr/bin/env bun
/**
 * Codex bridge daemon.
 *
 * Polls the local broker for messages addressed to Codex peers and wakes the
 * destination Codex thread with `codex exec resume <thread_id> -`.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  BridgePendingMessage,
  BridgePendingResponse,
} from "./shared/types.ts";

const BROKER_PORT = parseInt(
  process.env.CODEX_THREADS_PORT ?? process.env.CLAUDE_PEERS_PORT ?? "7899",
  10
);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const POLL_INTERVAL_MS = parseInt(process.env.CODEX_THREADS_BRIDGE_POLL_MS ?? "1000", 10);
const CODEX_CLI_PATH =
  process.env.CODEX_CLI_PATH ?? "/Applications/Codex.app/Contents/Resources/codex";
const PID_FILE =
  process.env.CODEX_THREADS_BRIDGE_PID ??
  `${process.env.HOME}/.codex-threads/bridge-${BROKER_PORT}.pid`;

export function buildCodexResumeCommand(command: string, threadId: string) {
  return {
    command,
    args: ["exec", "resume", "--skip-git-repo-check", threadId, "-"],
  };
}

export function buildWakePrompt(message: BridgePendingMessage): string {
  const remaining = Math.max(0, 200 - message.sequence);
  const shouldReply = message.sequence < 200;

  return `You received a codex-threads-mcp peer message.

<codex-threads-message conversation_id="${message.conversation_id}" sequence="${message.sequence}" remaining_messages="${remaining}" from_id="${message.from_id}" from_summary="${escapeAttr(message.from_summary)}" from_cwd="${escapeAttr(message.from_cwd)}" sent_at="${message.sent_at}">
${message.text}
</codex-threads-message>

Instructions:
- Treat this as an active peer conversation between Codex threads.
- Respond immediately to the sender unless sequence is 200.
- The conversation limit is 100 exchanges, represented as 200 total messages.
- If you respond, call send_message with exactly:
  - to_id: "${message.from_id}"
  - conversation_id: "${message.conversation_id}"
  - message: your reply
- Keep the reply concise and directly useful.

${shouldReply ? "Now respond with send_message." : "This is the final allowed message. Do not send another reply."}`;
}

function escapeAttr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Broker ${path} failed: ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

function log(message: string) {
  console.error(`[codex-threads bridge] ${message}`);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireSingleton(pidFile: string): boolean {
  if (existsSync(pidFile)) {
    const existingPid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    if (Number.isFinite(existingPid) && isPidAlive(existingPid)) {
      return false;
    }
    rmSync(pidFile, { force: true });
  }

  mkdirSync(dirname(pidFile), { recursive: true });
  writeFileSync(pidFile, `${process.pid}\n`, { mode: 0o600 });
  return true;
}

function releaseSingleton(pidFile: string) {
  try {
    const existingPid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    if (existingPid === process.pid) {
      rmSync(pidFile, { force: true });
    }
  } catch {
    // best effort
  }
}

async function resumeCodexThread(message: BridgePendingMessage): Promise<boolean> {
  const { command, args } = buildCodexResumeCommand(CODEX_CLI_PATH, message.to_thread_id);
  const prompt = buildWakePrompt(message);
  const proc = Bun.spawn([command, ...args], {
    stdin: "pipe",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  proc.stdin.write(prompt);
  proc.stdin.end();
  const exitCode = await proc.exited;
  return exitCode === 0;
}

async function runOnce(): Promise<void> {
  const pending = await brokerFetch<BridgePendingResponse>("/bridge/pending", { limit: 10 });
  for (const message of pending.messages) {
    log(`waking thread ${message.to_thread_id} for message ${message.id}`);
    const ok = await resumeCodexThread(message);
    if (ok) {
      await brokerFetch("/bridge/mark-delivered", { id: message.id });
    } else {
      log(`codex resume failed for message ${message.id}; will retry`);
    }
  }
}

async function main() {
  if (!acquireSingleton(PID_FILE)) {
    log(`already running for broker port ${BROKER_PORT}`);
    return;
  }

  const cleanup = () => {
    releaseSingleton(PID_FILE);
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("exit", () => releaseSingleton(PID_FILE));

  log(`listening for Codex messages via ${BROKER_URL}`);
  while (true) {
    try {
      await runOnce();
    } catch (e) {
      log(e instanceof Error ? e.message : String(e));
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

if (import.meta.main) {
  main().catch((e) => {
    log(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
