# codex-threads-mcp

Local peer discovery and auto-reply messaging for Codex threads.

This project is a fork of [`louislva/claude-peers-mcp`](https://github.com/louislva/claude-peers-mcp). It keeps the same local broker idea and adds Codex thread wakeups through `codex exec resume`.

## What it does

Each Codex thread starts an MCP server that registers with a local broker on `127.0.0.1`. Peers can discover each other and send messages by peer ID. When the target peer is a Codex thread, a bridge daemon resumes the destination thread with the message and asks it to respond through the same MCP tool.

```text
Codex thread A
  -> send_message(to_id: B)
  -> local broker + SQLite
  -> codex bridge
  -> codex exec resume <thread B>
  -> thread B calls send_message(to_id: A, conversation_id: ...)
```

Automatic conversations stop after **100 exchanges**, implemented as **200 total messages** in a conversation.

## Install

```bash
git clone https://github.com/dazman-codex/codex-threads-mcp.git ~/codex-threads-mcp
cd ~/codex-threads-mcp
bun install
```

## Register in Codex

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.codex_threads]
command = "/absolute/path/to/bun"
args = ["/absolute/path/to/codex-threads-mcp/server.ts"]
startup_timeout_sec = 30

[mcp_servers.codex_threads.env]
PATH = "/absolute/path/to/bun-dir:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
CODEX_THREADS_PORT = "7899"
CODEX_THREADS_DB = "/absolute/path/to/.codex-threads.db"
```

Adjust the paths if you cloned the repo somewhere else.

## Tools

| Tool | Description |
| --- | --- |
| `list_peers` | List local Codex or Claude peers by machine, directory, or repo. |
| `send_message` | Send a message to a peer ID. Optional `conversation_id` continues an auto-reply chain. |
| `set_summary` | Set a short visible summary for peer discovery. |
| `check_messages` | Manually read queued messages when automatic delivery is unavailable. |

## Commands

```bash
bun run server       # MCP server
bun run broker       # local broker only
bun run bridge       # Codex wakeup bridge only
bun cli.ts status    # broker status
bun cli.ts peers     # list peers
bun cli.ts send <peer-id> <message>
bun cli.ts kill-broker
bun test
```

## Configuration

| Environment variable | Default | Description |
| --- | --- | --- |
| `CODEX_THREADS_PORT` | `7899` | Local broker port. |
| `CODEX_THREADS_DB` | `~/.codex-threads.db` | SQLite database path. |
| `CODEX_THREADS_AUTOSTART_BRIDGE` | enabled | Set to `0` to stop Codex peers from starting the bridge. |
| `CODEX_THREADS_BRIDGE_POLL_MS` | `1000` | Bridge polling interval. |
| `CODEX_THREADS_BRIDGE_PID` | `~/.codex-threads/bridge-<port>.pid` | Singleton pid file. |
| `CODEX_CLI_PATH` | `/Applications/Codex.app/Contents/Resources/codex` | Codex CLI path used by the bridge. |
| `OPENAI_API_KEY` | unset | Optional startup auto-summary support inherited from the original project. |

Legacy `CLAUDE_PEERS_PORT` and `CLAUDE_PEERS_DB` are still accepted as fallbacks.

## Notes

- The broker and bridge are localhost-only.
- Codex thread IDs come from `CODEX_THREAD_ID`, which the Codex app exposes to running sessions.
- Claude Code channel delivery from the original project remains for non-Codex peers, but Codex uses the bridge because it does not consume `notifications/claude/channel`.
