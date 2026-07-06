# Codex Threads MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `codex-threads-mcp`, a public fork of `claude-peers-mcp` that wakes Codex threads and lets peers auto-reply through Codex session resumes.

**Architecture:** Keep the original local broker and MCP tools, then add Codex-aware peer metadata and a bridge daemon. The bridge reads broker messages for Codex peers, resumes the destination Codex thread with a structured prompt, and relies on the destination MCP tool call to send the reply back.

**Tech Stack:** Bun, TypeScript, `@modelcontextprotocol/sdk`, Bun SQLite, Codex CLI.

## Global Constraints

- Repository name and package name are `codex-threads-mcp`.
- Preserve local-only broker behavior on `127.0.0.1`.
- Preserve original peer-discovery tools: `list_peers`, `send_message`, `set_summary`, `check_messages`.
- Codex peers register `CODEX_THREAD_ID` when present.
- Auto conversation limit is 100 exchanges, implemented as 200 messages per conversation.
- No secrets are logged or committed.
- Public docs must not contain local-only private project details.

---

### Task 1: Broker Metadata and Conversation Limit

**Files:**
- Modify: `shared/types.ts`
- Modify: `broker.ts`
- Create: `broker.test.ts`

**Interfaces:**
- Produces: `Peer.thread_id`, `Peer.client_kind`, `Message.conversation_id`, `Message.sequence`, `BridgePendingMessage`.
- Produces: broker endpoints `/bridge/pending` and `/bridge/mark-delivered`.

- [x] Write tests for Codex peer registration, bridge pending messages, and the 200-message cap.
- [x] Run `bun test broker.test.ts` and verify the new tests fail before implementation.
- [x] Add database columns with migration-safe `ALTER TABLE` handling.
- [x] Add optional `conversation_id` support to `/send-message`.
- [x] Add `/bridge/pending` and `/bridge/mark-delivered`.
- [x] Run `bun test broker.test.ts` and verify tests pass.

### Task 2: MCP Server Codex Awareness

**Files:**
- Modify: `server.ts`
- Test: `broker.test.ts`

**Interfaces:**
- Consumes: `RegisterRequest.thread_id`, `RegisterRequest.client_kind`, `SendMessageRequest.conversation_id`.
- Produces: Codex peers do not consume queued messages through Claude channel polling.

- [x] Write tests or smoke validation proving `send_message` accepts optional `conversation_id`.
- [x] Register `CODEX_THREAD_ID` and `client_kind="codex"` when running under Codex.
- [x] Keep Claude channel polling only for non-Codex peers.
- [x] Start the Codex bridge automatically for Codex peers unless disabled by env.
- [x] Run `bun test`.

### Task 3: Codex Bridge Daemon

**Files:**
- Create: `codex-bridge.ts`
- Create: `codex-bridge.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `/bridge/pending`.
- Produces: Codex CLI command `codex exec resume <thread_id> -`.

- [x] Write tests for prompt construction and command argument construction.
- [x] Run `bun test codex-bridge.test.ts` and verify tests fail before implementation.
- [x] Implement singleton pid-file handling.
- [x] Implement polling loop and Codex resume spawning.
- [x] Include conversation metadata and explicit auto-reply instruction in the wake prompt.
- [x] Mark messages bridge-delivered only after a successful spawn.
- [x] Run `bun test`.

### Task 4: Rename and Public Documentation

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: `cli.ts`
- Modify: `CLAUDE.md`

**Interfaces:**
- Produces: install instructions for Codex under MCP name `codex_threads`.

- [x] Rename package metadata from `claude-peers` to `codex-threads-mcp`.
- [x] Document Codex registration in `~/.codex/config.toml`.
- [x] Document auto-reply behavior and 100-exchange cap.
- [x] Keep Claude compatibility notes short and clear.
- [x] Run `bun test` and `bunx tsc --noEmit`.

### Task 5: Publish

**Files:**
- Git metadata only.

**Interfaces:**
- Produces: public GitHub fork `dazman-codex/codex-threads-mcp`.

- [x] Verify `gh api user --jq .login` is `dazman-codex`.
- [x] Verify local git author is `dazman-codex`.
- [ ] Commit implementation.
- [ ] Push branch `codex/codex-threads-mcp` to the public fork.
- [ ] If validation is clean, fast-forward fork `main` to the implementation commit and push.
