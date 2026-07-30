# ChainMemory MCP Server

[![npm version](https://img.shields.io/npm/v/chainmemory-mcp.svg)](https://www.npmjs.com/package/chainmemory-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/node/v/chainmemory-mcp.svg)](https://nodejs.org)

> Cross-model, cryptographically verifiable memory for Claude, ChatGPT, and any AI agent — own your AI's memory and carry it across every model.

ChainMemory MCP exposes the [ChainMemory](https://chainmemory.ai) protocol to any AI agent that speaks the Model Context Protocol. Memories are encrypted at rest (AES-256-GCM, per-user), verifiable with Merkle proofs, and portable across ChatGPT, Claude, Gemini, Perplexity, and any other LLM. No vendor lock-in, ever.

## What's new in v2.5.6

Three defects that made tools report confidently wrong things. No new tools.

- **`list_project_templates` never listed anything.** It read `templates` / `template_id` from a response that returns `defaults` / `project_id`, so it always answered "No templates available" — which meant nobody could learn the id that `add_project_from_template` needs. The whole template flow was unreachable.
- **`chainmemory_profile` got five of eight fields wrong.** It read `wallet`, `memory_count`, `trust_score`, `registration_block` and `sealed`; the API returns `owner`, `chain_memories` / `local_memories`, `reputation` and `active`. Every profile came back with an empty wallet, zero memories, `?` reputation and `Sealed: no`, regardless of the real state. It also had no handling for an API key with no registered identity, printing `AI Profile #undefined`.
- **`update_project_state` hid the reason when every op was rejected.** Rejections were only rendered on the success path, but rejecting *all* ops leaves the state unchanged and takes the other branch — so the reply said `Rejected: 3` and nothing else. The only way to find out why was to guess again and pay the fee again.

## What's new in v2.5.5

- **`audit_memory`** and **`audit_state`** — the two forensic audit endpoints, now reachable from any MCP client. Both accept **`dry_run: true`**, which returns the identical result **without charging**: an audit you can run as often as you like, and pay for only when you need the receipt on record. `audit_state` costs 5 AIC in its paid form, so the tools default to the dry run.
- Both endpoints were fixed server-side first: they used to charge **before** validating, so a mistyped id or project name cost the fee and returned 404.

## What's new in v2.5.4

**Search and full reads**

- **`search_memories`** — semantic search over your memories (cosine similarity over cached embeddings, blended with recency and importance), returning the **full text** of each match. Previous versions exposed no search at all
- **`get_memory`** — read one memory in full, decrypted from chain, with an integrity check: the server recomputes the event hash from the plaintext and compares it against the hash anchored on-chain
- `chainmemory_recall` and `list_memories_filtered` now state plainly that they return **80-character previews**, and point to `get_memory` / `search_memories` for the full text

**Verification — free, and the point of the product**

- **`verify_project_state`** — public, unauthenticated proof of a Project Brain: every anchored version with its `state_hash` and on-chain coordinates, plus how to check them yourself in the `ProjectStateAnchor` contract. No content is exposed
- **`get_memory_proof`** — the shareable anchoring proof of a single memory: `event_hash` plus its on-chain coordinates. A third party verifies it **without your API key**, and the content is never revealed

**Cost control**

- **`quote_inject`** — price an inject before paying: which ids exist, which don't, tokens, exact cost with its burn/treasury split, and whether your balance covers it
- **Correct inject fee** — the client now takes the price and the remaining-injects count **from the server** instead of recomputing them. Previous versions divided by the pre-2026-06-30 price of 0.001 AIC and promised 100× more injects than the balance actually allowed

**Roles and hardening**

- **`list_role_contracts`** — discover a project's roles (id, version, status) before reading a contract or assuming a role. Role ids are not guessable; this removes the failed-call round trip
- **`include_roles` on `get_project_state`** — set to `false` to get the state without the full text of every signed role contract
- **Input hardening** — every user-supplied value that reaches a URL is now validated or escaped. Numeric path parameters must be integers, string path parameters are percent-encoded, and query limits are clamped. Invalid input fails locally with a clear message instead of going out to the network
- **`CHAINMEMORY_API_KEY` declared in the MCP manifest** — the only mandatory variable was missing from `server.json`, so registries and installers never prompted for it

## What's new in v2.5

- **Project Brain** — `get_project_state` consolidates your atomic memories into a structured, versioned, verifiable project state (decisions, risks, constraints, metrics, and environment: where and how you work), and delivers active role contracts with it in a single call
- **Verifiable Role Contracts (VRC)** — human-signed role contracts for AI agents: `get_role_contract` (read the contract), `assume_role` (open an audited Role Session), `release_role` (close with a summary)
- **34 tools total** — memory ops, semantic search, verification proofs, projects, Project Brain, role contracts with audited sessions, selective inject

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

Restart Claude Desktop. The 34 tools are now available.

### 3. Try it

- *"What do you remember about my projects?"* → `chainmemory_recall`
- *"Save this decision: switching to Postgres for the next sprint"* → `chainmemory_remember`
- *"Load the project state for my-app"* → `get_project_state` (Brain + active role contracts)
- *"Which roles exist for my-app?"* → `list_role_contracts`
- *"Assume the architect role for my-app"* → `assume_role` (audited Role Session)

## All 34 tools

### Memory ops (8)
| Tool | Description |
|---|---|
| `chainmemory_remember` | Write a permanent encrypted memory. Auto-tagged by content. |
| `chainmemory_recall` | Recall the user's recent memories, newest first (80-character previews) |
| `search_memories` | **Semantic** search over your memories — returns the full text of each match |
| `get_memory` | Read one memory in full, decrypted from chain, with an on-chain integrity check |
| `list_memories_filtered` | Filter by project tag and archived status (80-character previews) |
| `update_memory_tags` | Change tags on an existing memory |
| `archive_memory` | Hide a memory from recall (reversible) |
| `unarchive_memory` | Restore an archived memory |

### Verification (4)
| Tool | Description |
|---|---|
| `verify_project_state` | Public, unauthenticated proof of a Project Brain: every anchored version, its `state_hash` and on-chain coordinates, and how to check them yourself. No content exposed |
| `get_memory_proof` | Shareable anchoring proof of one memory: `event_hash` + on-chain coordinates. A third party verifies it without your API key |
| `audit_memory` | Forensic audit of one memory: recomputes its `event_hash` from the stored plaintext and compares it against the anchored one. **0.1 AIC**, or free with `dry_run: true` |
| `audit_state` | Full audit of a Project Brain: recomputes the `state_hash` with the deterministic engine, returns the on-chain anchor and the version history. **5 AIC**, or free with `dry_run: true` |

### Project Brain (2)
| Tool | Description |
|---|---|
| `get_project_state` | Consolidated, verifiable project state + active role contracts (state_hash, anchored on-chain). Pass `include_roles: false` to omit the contract bodies |
| `update_project_state` | Propose structured ops (29-op grammar, incl. environment); server validates, builds, hashes, persists |

### Verifiable Role Contracts (6)
| Tool | Description |
|---|---|
| `list_role_contracts` | List a project's roles with version and status — call it first when you don't know the `role_id` |
| `get_role_contract` | Read a role's contract: purpose, rules with checks and severity, working protocol. Accepts `version` to audit a past one, and flags a hash mismatch if the stored body no longer matches its `contract_hash` |
| `assume_role` | Open an audited Role Session under an active contract (pins contract + Brain hashes), and delivers the owner declared working environment |
| `release_role` | Close a Role Session with a summary of work done and pending |
| `list_role_sessions` | Audit trail: who assumed which role, when, how it closed, and the closing summary |
| `get_role_session` | One session in full, with the contract and Brain hashes it was pinned to |

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

### Selective inject — paid (4)
| Tool | Description |
|---|---|
| `get_inject_balance` | Check AIC balance and how many injects it covers |
| `quote_inject` | Price an inject **before** paying: ids found/missing, tokens, exact cost, sufficiency. Free |
| `inject_memories` | Inject 1-50 memories into current chat context (0.1 AIC, optimistic) |
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
2. Backend checks balance (≥ 0.1 AIC required — Fee Schedule v1.0)
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
