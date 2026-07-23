# ChainMemory MCP Server

[![npm version](https://img.shields.io/npm/v/chainmemory-mcp.svg)](https://www.npmjs.com/package/chainmemory-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/node/v/chainmemory-mcp.svg)](https://nodejs.org)

> Cross-model, cryptographically verifiable memory for Claude, ChatGPT, and any AI agent — own your AI's memory and carry it across every model.

ChainMemory MCP exposes the [ChainMemory](https://chainmemory.ai) protocol to any AI agent that speaks the Model Context Protocol. Memories are encrypted at rest (AES-256-GCM, per-user), verifiable with Merkle proofs, and portable across ChatGPT, Claude, Gemini, Perplexity, and any other LLM. No vendor lock-in, ever.

## What's new in v2.5

- **Project Brain** — `get_project_state` consolidates your atomic memories into a structured, versioned, verifiable project state (decisions, risks, constraints, metrics), and delivers active role contracts with it in a single call
- **Verifiable Role Contracts (VRC)** — human-signed role contracts for AI agents: `get_role_contract` (read the contract), `assume_role` (open an audited Role Session), `release_role` (close with a summary)
- **24 tools total** — memory ops, projects, Project Brain, roles, selective inject

## Quick start

### 1. Get an API key

Visit [https://faucet.chainmemory.ai](https://faucet.chainmemory.ai). You receive an API key (`aic_...`) and a starter balance of AIC. ChainMemory collects no personal data — your key is your identity.

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

Restart Claude Desktop. The 24 tools are now available.

### 3. Try it

- *"What do you remember about my projects?"* → `chainmemory_recall`
- *"Save this decision: switching to Postgres for the next sprint"* → `chainmemory_remember`
- *"Load the project state for my-app"* → `get_project_state` (Brain + active role contracts)
- *"Assume the architect role for my-app"* → `assume_role` (audited Role Session)

## All 24 tools

### Memory ops (6)
| Tool | Description |
|---|---|
| `chainmemory_remember` | Write a permanent encrypted memory. Auto-tagged by content. |
| `chainmemory_recall` | Recall the user's recent memories (most recent first) |
| `list_memories_filtered` | Filter by project tag and archived status |
| `update_memory_tags` | Change tags on an existing memory |
| `archive_memory` | Hide a memory from recall (reversible) |
| `unarchive_memory` | Restore an archived memory |

### Project Brain (2)
| Tool | Description |
|---|---|
| `get_project_state` | Consolidated, verifiable project state + active role contracts (state_hash, anchored on-chain) |
| `update_project_state` | Propose structured ops (22-op grammar); server validates, builds, hashes, persists |

### Verifiable Role Contracts (3)
| Tool | Description |
|---|---|
| `get_role_contract` | Read a role's contract: purpose, rules with checks and severity, working protocol |
| `assume_role` | Open an audited Role Session under an active contract (pins contract + Brain hashes) |
| `release_role` | Close a Role Session with a summary of work done and pending |

### Projects (5)
| Tool | Description |
|---|---|
| `list_projects` | List the user's projects |
| `create_project` | Create a custom project tag with optional auto-tag keywords |
| `delete_project` | Delete a project tag |
| `list_project_templates` | List built-in templates |
| `add_project_from_template` | Instantiate a built-in template |

### Identity & stats (4)
| Tool | Description |
|---|---|
| `chainmemory_stats` | Network stats (AIs, memories, blocks, AIC supply) |
| `chainmemory_register` | Register a new AI identity on-chain |
| `chainmemory_profile` | Get an AI's profile and trust score |
| `chainmemory_seal` | Seal a memory permanently (requires `AICHAIN_KEY`) |

### Cross-platform context (1)
| Tool | Description |
|---|---|
| `get_my_context` | Portable verified context across all platforms |

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

1. User (or AI) calls `inject_memories` with a list of IDs
2. Backend checks balance (≥ 0.001 AIC required)
3. **Optimistic response (<500ms)**: plaintexts returned immediately, transactions queued
4. Background: 50% of the fee goes to the ecosystem treasury, 50% is burned
5. `get_inject_history` shows confirmation status

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  AI Agent (Claude Desktop, ChatGPT, any MCP client)         │
└──────────────────┬──────────────────────────────────────────┘
                   │ MCP stdio
                   ↓
┌─────────────────────────────────────────────────────────────┐
│  chainmemory-mcp v2.5  (this package)                       │
└──────────────────┬──────────────────────────────────────────┘
                   │ HTTPS + x-api-key
                   ↓
┌─────────────────────────────────────────────────────────────┐
│  api.chainmemory.ai                                         │
│  - per-user encryption at rest (AES-256-GCM)                │
│  - Project Brain (deterministic builder + state_hash)       │
│  - Role contracts + audited Role Sessions                   │
│  - SQLite + Merkle proofs                                   │
└──────────────────┬──────────────────────────────────────────┘
                   │ JSON-RPC
                   ↓
┌─────────────────────────────────────────────────────────────┐
│  ChainMemory L1 — Chain ID 202604                           │
│  - Geth PoA Clique, 3 validators                            │
│  - Memory contract + daily checkpoint anchoring             │
│  - Project State anchoring (public verification)            │
└─────────────────────────────────────────────────────────────┘
```

## License

MIT
