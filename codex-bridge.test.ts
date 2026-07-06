import { expect, test } from "bun:test";
import {
  buildCodexResumeCommand,
  buildWakePrompt,
} from "./codex-bridge.ts";
import type { BridgePendingMessage } from "./shared/types.ts";

const message: BridgePendingMessage = {
  id: 42,
  conversation_id: "abc123def456",
  sequence: 7,
  from_id: "peer-a",
  from_summary: "Chat A working on tests",
  from_cwd: "/repo/a",
  from_thread_id: "thread-a",
  to_id: "peer-b",
  to_summary: "Chat B reviewing",
  to_cwd: "/repo/b",
  to_thread_id: "thread-b",
  text: "Can you review the broker tests?",
  sent_at: "2026-07-06T00:00:00.000Z",
  delivered: false,
  bridge_delivered: false,
};

test("buildCodexResumeCommand resumes the destination thread from stdin", () => {
  expect(buildCodexResumeCommand("/Applications/Codex.app/Contents/Resources/codex", "thread-b")).toEqual({
    command: "/Applications/Codex.app/Contents/Resources/codex",
    args: ["exec", "resume", "--skip-git-repo-check", "thread-b", "-"],
  });
});

test("buildWakePrompt includes routing metadata and reply instructions", () => {
  const prompt = buildWakePrompt(message);

  expect(prompt).toContain('conversation_id="abc123def456"');
  expect(prompt).toContain('sequence="7"');
  expect(prompt).toContain('from_id="peer-a"');
  expect(prompt).toContain("Can you review the broker tests?");
  expect(prompt).toContain("send_message");
  expect(prompt).toContain("conversation_id: \"abc123def456\"");
  expect(prompt).toContain("to_id: \"peer-a\"");
  expect(prompt).toContain("100 exchanges");
});
