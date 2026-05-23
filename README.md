# ChainMemory MCP Server

[![npm version](https://img.shields.io/npm/v/chainmemory-mcp.svg)](https://www.npmjs.com/package/chainmemory-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/node/v/chainmemory-mcp.svg)](https://nodejs.org)

> Give Claude and any MCP-compatible AI permanent, portable, verifiable memory on the ChainMemory blockchain.

ChainMemory MCP exposes the [ChainMemory](https://chainmemory.ai) protocol to any AI agent that speaks the Model Context Protocol. Memories are encrypted client-side, anchored on-chain (Chain ID 202604), and portable across ChatGPT, Claude, Gemini, Perplexity, and any other LLM.

## What's new in v2.2.0

- **12 new tools** for memory organization and selective context injection
- **Projects + auto-tagging** — organize memories with project tags, define keywords for auto-tag rules
- **Archive / unarchive** — hide memories from recall without losing them
- **Selective inject** (paid) — inject 1-50 memories into a chat context for 0.001 AIC. 50% burned (deflationary), 50% to ecosystem treasury. Optimistic confirmation: returns plaintexts in <500ms while the on-chain payment confirms in background
- **All tools routed through the REST API** — no private key required for memory ops (encryption is server-side per-user)
- **Single env var** required to install: `CHAINMEMORY_API_KEY`

## Quick start

### 1. Get an API key

Visit [https://faucet.chainmemory.ai](https://faucet.chainmemory.ai) and connect a wallet. You receive:
- An API key (for ops via REST)
- A starter balance of AIC (for selective inject, faucet caps at 0.1 AIC)

### 2. Add to Claude Desktop

Edit your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "chainmemory": {
      "command": "npx",
      "args": ["-y", "chainmemory-mcp"],
      "env": {
        "CHAINMEMORY_API_KEY": "aic_your_key_here"
      }
    }
  }
}
```

Restart Claude Desktop. The 19 tools are now available.

### 3. Try it

In Claude Desktop, ask:
- *"What do you remember about my projects?"* → `chainmemory_recall` is called
- *"Save this decision: switching to Postgres for the next sprint"* → `chainmemory_remember`
- *"Inject my last 5 blockchain memories into this chat"* → `inject_memories` (uses 0.001 AIC)

## All 19 tools

### Memory ops (6)

| Tool | Description |
|---|---|
| `chainmemory_remember` | Write a permanent encrypted memory. Auto-tagged by content. |
| `chainmemory_recall` | Recall the user's recent memories (most recent first) |
| `list_memories_filtered` | Filter by project tag and archived status |
| `update_memory_tags` | Change tags on an existing memory |
| `archive_memory` | Hide a memory from recall (reversible) |
| `unarchive_memory` | Restore an archived memory |

### Identity & stats (4)

| Tool | Description |
|---|---|
| `chainmemory_stats` | Network stats (AIs, memories, blocks, AIC supply) |
| `chainmemory_register` | Register a new AI identity on-chain |
| `chainmemory_profile` | Get an AI's profile and trust score |
| `chainmemory_seal` | Seal a memory permanently (requires `AICHAIN_KEY`) |

### Projects (5)

| Tool | Description |
|---|---|
| `list_projects` | List the user's projects |
| `create_project` | Create a custom project tag with optional auto-tag keywords |
| `delete_project` | Delete a project tag |
| `list_project_templates` | List built-in templates (general, development, blockchain, business, personal, research) |
| `add_project_from_template` | Instantiate a built-in template |

### Cross-platform context (1)

| Tool | Description |
|---|---|
| `get_my_context` | Portable verified context across all platforms (v2.1 feature) |

### Selective inject — paid (3)

| Tool | Description |
|---|---|
| `get_inject_balance` | Check AIC balance |
| `inject_memories` | Inject 1-50 memories into current chat context (0.001 AIC, optimistic) |
| `get_inject_history` | History of inject operations |

## Environment variables

| Var | Required | Description |
|---|---|---|
| `CHAINMEMORY_API_KEY` | **Yes** | Your API key from the faucet |
| `CHAINMEMORY_API_BASE` | No | Default `https://api.chainmemory.ai` |
| `AICHAIN_KEY` | No | Wallet private key — only required by `chainmemory_seal` |
| `AICHAIN_RPC` | No | Default `https://rpc.chainmemory.ai` — only for `chainmemory_seal` |

For most users only `CHAINMEMORY_API_KEY` is needed.

## How selective inject works

Selective inject is the only paid operation. The flow:

1. User (or AI) calls `inject_memories` with a list of IDs
2. Backend checks balance (≥ 0.001 AIC required)
3. **Optimistic response (<500ms)**: plaintexts returned immediately, transactions queued
4. Background: 0.0005 AIC sent to treasury, 0.0005 AIC sent to burn address `0x...dEaD`
5. `get_inject_history` shows confirmation status

The deflationary burn means total AIC supply decreases with usage. Treasury portion funds infrastructure and validator rewards.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  AI Agent (Claude Desktop, etc)                             │
└──────────────────┬──────────────────────────────────────────┘
                   │ MCP stdio
                   ↓
┌─────────────────────────────────────────────────────────────┐
│  chainmemory-mcp v2.2.0  (this package)                     │
└──────────────────┬──────────────────────────────────────────┘
                   │ HTTPS + x-api-key
                   ↓
┌─────────────────────────────────────────────────────────────┐
│  api.chainmemory.ai                                         │
│  - per-user encryption (AES-256-GCM, key from API+wallet)   │
│  - auto-tag classifier                                      │
│  - SQLite + Merkle proofs                                   │
│  - Optimistic inject (parallel tx)                          │
└──────────────────┬──────────────────────────────────────────┘
                   │ JSON-RPC
                   ↓
┌─────────────────────────────────────────────────────────────┐
│  ChainMemory L1 — Chain ID 202604                           │
│  - Geth PoA Clique                                          │
│  - V2 memory contract (encrypted on-chain content)          │
│  - Daily checkpoint anchoring                               │
└─────────────────────────────────────────────────────────────┘
```

## License

MIT
