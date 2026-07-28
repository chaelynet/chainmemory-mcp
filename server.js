#!/usr/bin/env node
// ============================================================
// ChainMemory MCP Server v2.5.5
// ============================================================
// All tools route through the ChainMemory REST API
// (https://api.chainmemory.ai by default). This means:
//   - One env var to configure: CHAINMEMORY_API_KEY
//   - No private key required for memory ops (encryption is
//     handled server-side with per-user keys derived from the
//     API key + wallet)
//   - Backend handles V2 contract, auto-tag, anti-hallucination,
//     and chain selection transparently
//
// 34 tools available:
//
//   Memory ops:
//     - chainmemory_remember           — write memory
//     - chainmemory_recall             — recall last N memories (80-char previews)
//     - search_memories                — SEMANTIC search, returns full text (v2.5.4)
//     - get_memory                     — read one memory in full + integrity check (v2.5.4)
//     - list_memories_filtered         — filter by project/tags/archived (80-char previews)
//     - update_memory_tags             — change tags on a memory
//     - archive_memory                 — hide from recall
//     - unarchive_memory               — restore archived
//
//   Verification (free — this is the point of the product):
//     - get_memory_proof               — shareable anchoring proof of one memory (v2.5.4)
//     - verify_project_state           — public on-chain proof of a Brain, no auth (v2.5.4)
//     - audit_memory                   — auditoria forense de una memoria (v2.5.5, 0.1 AIC o dry_run)
//     - audit_state                    — auditoria del Brain (v2.5.5, 5 AIC o dry_run)
//
//   Identity / stats:
//     - chainmemory_stats              — network stats
//     - chainmemory_register           — register this AI
//     - chainmemory_profile            — get AI profile
//     - chainmemory_seal               — seal memory (on-chain, requires AICHAIN_KEY)
//
//   Projects (organization):
//     - list_projects                  — list user's projects
//     - create_project                 — create a project
//     - delete_project                 — delete a project
//     - list_project_templates         — list built-in templates
//     - add_project_from_template      — instantiate template
//
//   Cross-platform / context:
//     - get_my_context                 — retrieve portable context (v2.1)
//
//   Project Brain (estado consolidado verificable):
//     - get_project_state              — leer el estado consolidado (+ contratos de rol activos)
//     - update_project_state           — proponer ops de la gramatica de 29 ops
//
//   VRC — Verifiable Role Contracts (los 6 endpoints del modulo, completos):
//     - list_role_contracts            — listar los roles del proyecto (v2.5.4)
//     - get_role_contract              — leer el contrato de un rol (?version=N)
//     - assume_role                    — abrir Role Session auditada (0.001 AIC)
//     - release_role                   — cerrar Role Session con resumen
//     - list_role_sessions             — rastro de auditoria del proyecto (v2.5.4)
//     - get_role_session               — una sesion en detalle, con sus hashes (v2.5.4)
//
//   Selective inject (paid, optimistic):
//     - get_inject_balance             — check AIC balance
//     - quote_inject                   — price it BEFORE paying (v2.5.4, free)
//     - inject_memories                — inject memories to current chat (0.1 AIC)
//     - get_inject_history             — history of inject ops
//
// Required env:
//   CHAINMEMORY_API_KEY   — your API key (get at https://faucet.chainmemory.ai)
//
// Optional env:
//   CHAINMEMORY_API_BASE  — default https://api.chainmemory.ai
//   AICHAIN_KEY           — private key (only needed for chainmemory_seal)
//   AICHAIN_RPC           — default https://rpc.chainmemory.ai (only for seal)
// ============================================================

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");

// ethers is only required if user wants to call chainmemory_seal (on-chain op).
// We lazy-load it to keep cold start fast.
let ethers = null;
function loadEthers() {
    if (!ethers) ethers = require("ethers");
    return ethers;
}

// ------------------------------------------------------------
// Configuration
// ------------------------------------------------------------

const API_BASE = process.env.CHAINMEMORY_API_BASE || "https://api.chainmemory.ai";
const API_KEY = process.env.CHAINMEMORY_API_KEY || null;

// V2 contract address (Sprint 4 migration). Only used by chainmemory_seal.
const V2_MEMORY_CONTRACT = "0xE84224e2660fd620aA6d09522718Ae0e5cF33F7d";
const V2_SEAL_ABI = ["function sealMemory(uint256,uint256)"];

// ------------------------------------------------------------
// HTTP helpers
// ------------------------------------------------------------

async function apiRequest(method, path, body = null, { timeoutMs = 15000 } = {}) {
    if (!API_KEY) {
        throw new Error(
            "CHAINMEMORY_API_KEY env variable not set. " +
            "Get one at https://faucet.chainmemory.ai"
        );
    }
    const url = `${API_BASE}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const opts = {
            method,
            headers: {
                "x-api-key": API_KEY,
                "Content-Type": "application/json"
            },
            signal: controller.signal
        };
        if (body !== null) opts.body = JSON.stringify(body);

        const res = await fetch(url, opts);
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); }
        catch { data = { raw: text }; }

        if (!res.ok) {
            const errMsg = data.error || data.message || `HTTP ${res.status}`;
            const err = new Error(errMsg);
            err.status = res.status;
            err.data = data;
            throw err;
        }
        return data;
    } finally {
        clearTimeout(timer);
    }
}

const apiGet    = (path, opts) => apiRequest("GET", path, null, opts);
const apiPost   = (path, body, opts) => apiRequest("POST", path, body, opts);
const apiPut    = (path, body, opts) => apiRequest("PUT", path, body, opts);
const apiDelete = (path, opts) => apiRequest("DELETE", path, null, opts);

// ------------------------------------------------------------
// Path/query parameter guards (v2.5.4)
// ------------------------------------------------------------
// El inputSchema declara los tipos, pero un cliente MCP puede enviar cualquier
// cosa: la validacion de esquema no la garantiza el transporte. Todo valor que
// termine dentro de una URL se valida o se escapa aca antes de salir.

function pathInt(value, field) {
    const n = typeof value === "number" ? value : Number(String(value).trim());
    if (!Number.isInteger(n) || n < 0) {
        throw new Error(`${field} must be a non-negative integer (received: ${JSON.stringify(value)})`);
    }
    return n;
}

function pathStr(value, field) {
    if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`${field} must be a non-empty string (received: ${JSON.stringify(value)})`);
    }
    return encodeURIComponent(value);
}

function boundedInt(value, { def, min, max }) {
    const n = Number(value);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, Math.trunc(n)));
}

// ------------------------------------------------------------
// Server setup
// ------------------------------------------------------------

const sv = new Server(
    { name: "chainmemory", version: "2.5.5" },
    { capabilities: { tools: {} } }
);

// ------------------------------------------------------------
// Tool list
// ------------------------------------------------------------

sv.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        // ── Memory ops ──
        {
            name: "chainmemory_remember",
            description: "Write a permanent encrypted memory to ChainMemory. Auto-tags by content. Importance 1-10. Use for important decisions, learnings, milestones the user wants permanently recorded.",
            inputSchema: {
                type: "object",
                properties: {
                    summary: { type: "string", description: "What happened (will be encrypted before chain anchoring)" },
                    content: { type: "string", description: "Optional alias of summary. If present it OVERRIDES summary as the stored memory text. 'summary' is the required field: send it always, and use 'content' only when you need a longer body than the summary." },
                    project: { type: "string", description: "Project to file this memory under (added as first tag)" },
                    tags: { type: "array", items: { type: "string" }, maxItems: 10, description: "Explicit tags; auto-tagging only used as fallback" },
                    category: {
                        type: "string",
                        enum: ["DECISION", "LEARNING", "INTERACTION", "STATE", "ERROR", "MILESTONE", "CUSTOM"],
                        description: "Memory category"
                    },
                    importance: { type: "integer", minimum: 1, maximum: 10, description: "1-10 importance (default 5)" },
                    platform: { type: "string", description: "Platform source (e.g. claude, chatgpt). Optional." }
                },
                required: ["summary"]
            }
        },
        {
            name: "chainmemory_recall",
            description: "Recall the user's most recent memories, newest first. Use at conversation start for continuity. IMPORTANT: this returns an 80-character PREVIEW of each memory, not the full text — to read one in full use get_memory(#N), and to find something by meaning use search_memories.",
            inputSchema: {
                type: "object",
                properties: {
                    count: { type: "integer", minimum: 1, maximum: 100, description: "Number of memories (default 10)" }
                }
            }
        },
        {
            name: "search_memories",
            description: "SEMANTIC search over the user's memories (cosine similarity over cached embeddings, blended with recency and importance). Returns the FULL text of each match — unlike chainmemory_recall and list_memories_filtered, which return 80-character previews. Use this whenever you need to FIND something rather than list the latest.",
            inputSchema: {
                type: "object",
                properties: {
                    q: { type: "string", description: "Natural-language query. Searched semantically, not by keyword." },
                    limit: { type: "integer", minimum: 1, maximum: 20, description: "Max results (default 10, server caps at 20)" }
                },
                required: ["q"]
            }
        },
        {
            name: "get_memory",
            description: "Read ONE memory in full, decrypted from chain, with an integrity check: the server recomputes the event_hash from the plaintext and compares it against the hash anchored on-chain. Use it when a preview is not enough, or to prove a specific memory has not been altered. Requires the memory to be anchored already (freshly written memories anchor in ~30s).",
            inputSchema: {
                type: "object",
                properties: {
                    memory_number: { type: "integer", description: "Your memory number — the #N shown by recall/remember. Not a global id." }
                },
                required: ["memory_number"]
            }
        },
        {
            name: "get_memory_proof",
            description: "Get the shareable anchoring proof of one of your memories: event_hash plus its on-chain coordinates. A third party can verify that hash in the contract WITHOUT your API key, and the content is never exposed. This is the primitive behind 'verifiable without trusting the operator'. Free.",
            inputSchema: {
                type: "object",
                properties: {
                    memory_number: { type: "integer", description: "Your memory number (the #N shown in recall)" }
                },
                required: ["memory_number"]
            }
        },
        {
            name: "verify_project_state",
            description: "PUBLIC verification of a Project Brain: returns every anchored version with its state_hash and on-chain coordinates (anchor id, tx, block), plus the instructions to check them independently in the ProjectStateAnchor contract. Exposes no content — only hashes that are already public on-chain. Free, and the answer does not depend on trusting this server: call it, then verify on-chain yourself.",
            inputSchema: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Project name, e.g. 'chainmemory'" }
                },
                required: ["name"]
            }
        },
        {
            name: "audit_memory",
            description: "Full forensic audit of ONE memory: recomputes its event_hash from the stored plaintext, compares it against the hash anchored on-chain, and reports its anchoring coordinates and seal state. COSTS 0.1 AIC unless dry_run is true. ALWAYS call it with dry_run first — the dry run returns the identical result without charging, so paying only makes sense when you need the paid receipt on record.",
            inputSchema: {
                type: "object",
                properties: {
                    memory_number: { type: "integer", description: "Your memory number (the #N shown in recall)" },
                    dry_run: { type: "boolean", description: "true = validate and return the full result WITHOUT charging (default false). Prefer true." }
                },
                required: ["memory_number"]
            }
        },
        {
            name: "audit_state",
            description: "Full audit of a Project Brain: recomputes the state_hash of the current version with the deterministic engine, compares it against the stored one, and returns the on-chain anchor plus the version history. COSTS 5 AIC unless dry_run is true — the most expensive operation in the system. Do NOT call it without dry_run unless the user explicitly asked for the paid audit.",
            inputSchema: {
                type: "object",
                properties: {
                    project: { type: "string", description: "Project name, e.g. 'chainmemory'" },
                    dry_run: { type: "boolean", description: "true = validate and return the full result WITHOUT charging (default false). Strongly prefer true: a paid run costs 5 AIC." }
                },
                required: ["project"]
            }
        },
        {
            name: "quote_inject",
            description: "Price an inject BEFORE paying for it: which memory ids exist, which do not, total characters, estimated tokens, the exact AIC cost with its burn/treasury split, and whether the wallet balance covers it. Free. Call it before inject_memories whenever the ids are not certain — inject charges 0.1 AIC even if you picked the wrong ones.",
            inputSchema: {
                type: "object",
                properties: {
                    memory_ids: { type: "array", items: { type: "integer" }, description: "1-50 memory numbers (#N) to price" }
                },
                required: ["memory_ids"]
            }
        },
        {
            name: "list_memories_filtered",
            description: "List memories filtered by project tag and archived status, newest first. Returns metadata plus an 80-character PREVIEW of each memory — not the full text. Use get_memory(#N) to read one in full, or search_memories to find by meaning.",
            inputSchema: {
                type: "object",
                properties: {
                    project: { type: "string", description: "Filter by project tag (use 'general' for untagged)" },
                    archived: { type: "boolean", description: "Include archived memories (default false)" },
                    limit: { type: "integer", minimum: 1, maximum: 200, description: "Default 50" }
                }
            }
        },
        {
            name: "update_memory_tags",
            description: "Update the tags of a memory. Tags are project labels for organization.",
            inputSchema: {
                type: "object",
                properties: {
                    memory_id: { type: "integer", description: "Your memory number (the # shown in recall/remember, e.g. 489) — personal to your api key" },
                    tags: { type: "array", items: { type: "string" }, description: "New tag list (replaces current)" }
                },
                required: ["memory_id", "tags"]
            }
        },
        {
            name: "archive_memory",
            description: "Archive a memory: it stops appearing in recall and inject lists, but remains on-chain. Reversible.",
            inputSchema: {
                type: "object",
                properties: {
                    memory_id: { type: "integer", description: "Your memory number to archive (the # shown in recall)" }
                },
                required: ["memory_id"]
            }
        },
        {
            name: "unarchive_memory",
            description: "Restore an archived memory.",
            inputSchema: {
                type: "object",
                properties: {
                    memory_id: { type: "integer", description: "Your memory number to restore (the # shown in recall)" }
                },
                required: ["memory_id"]
            }
        },

        // ── Identity & stats ──
        {
            name: "chainmemory_stats",
            description: "Get ChainMemory network stats: total AIs registered, total memories, current block, AIC supply.",
            inputSchema: { type: "object", properties: {} }
        },
        {
            name: "chainmemory_register",
            description: "Register a new AI identity on-chain. Required once per AI before writing memories.",
            inputSchema: {
                type: "object",
                properties: {
                    name: { type: "string", description: "AI name" },
                    model: { type: "string", description: "Model name (e.g. claude-opus-4)" }
                },
                required: ["name", "model"]
            }
        },
        {
            name: "chainmemory_profile",
            description: "Get this AI's profile: name, model, memory count, trust score, registration block.",
            inputSchema: {
                type: "object",
                properties: {
                    ai_id: { type: "integer", description: "AI ID (omit for own)" }
                }
            }
        },
        {
            name: "chainmemory_seal",
            description: "Seal a memory permanently on-chain. Cannot be modified after. Requires AICHAIN_KEY env var. Direct contract call to V2.",
            inputSchema: {
                type: "object",
                properties: {
                    memory_id: { type: "integer", description: "Your memory number to seal (the # shown in recall)" },
                    ai_id: { type: "integer", description: "AI ID owning the memory" }
                },
                required: ["memory_id", "ai_id"]
            }
        },

        // ── Projects ──
        {
            name: "list_projects",
            description: "List the user's projects (custom tags for organizing memories).",
            inputSchema: { type: "object", properties: {} }
        },
        {
            name: "create_project",
            description: "Create a new project tag.",
            inputSchema: {
                type: "object",
                properties: {
                    project_id: { type: "string", description: "Short slug (e.g. 'blockchain', 'work_2026')" },
                    name: { type: "string", description: "Display name" },
                    keywords: { type: "array", items: { type: "string" }, description: "Auto-tag keywords (optional)" }
                },
                required: ["project_id", "name"]
            }
        },
        {
            name: "delete_project",
            description: "Delete a project tag. Memories with that tag keep the tag but the project metadata is removed.",
            inputSchema: {
                type: "object",
                properties: {
                    project_id: { type: "string", description: "Project ID to delete" }
                },
                required: ["project_id"]
            }
        },
        {
            name: "list_project_templates",
            description: "List built-in project templates (general, development, blockchain, business, personal, research).",
            inputSchema: { type: "object", properties: {} }
        },
        {
            name: "add_project_from_template",
            description: "Instantiate a built-in template as a user project. Use list_project_templates first to see available IDs.",
            inputSchema: {
                type: "object",
                properties: {
                    template_id: { type: "string", description: "Template ID (e.g. 'blockchain')" }
                },
                required: ["template_id"]
            }
        },

        // ── Cross-platform context (v2.1) ──
        {
            name: "get_my_context",
            description: "Retrieve the user's portable, verified AI conversation history from ChainMemory. Returns a condensed summary plus recent memories from all platforms (ChatGPT, Claude, Gemini, Perplexity, etc), with cryptographic verification status. Use this at the start of a conversation to provide continuity across AI providers.",
            inputSchema: {
                type: "object",
                properties: {
                    limit: { type: "integer", minimum: 1, maximum: 50, description: "Maximum memories (default 10)" },
                    verified_only: { type: "boolean", description: "If true, only return memories anchored on-chain (default false)" }
                }
            }
        },

        // -- Project Brain: estado consolidado por proyecto --
        {
            name: "get_project_state",
            description: "Get the consolidated, verifiable STATE of a project from Project Brain: a structured object (phase, current_focus, vocabulary, constraints, decisions with confidence and cited memory IDs, open_risks, next_priorities, and `environment` — where and how the owner works: hosts, services, repositories and operating rules) distilled from your atomic memories. Use it at the START of work on a known project to load its current state instead of re-deriving context. Owner-scoped (returns only your own state). Includes state_hash (SHA3-256) for integrity.",
            inputSchema: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Project name, e.g. 'chainmemory'" },
                    include_roles: { type: "boolean", description: "Embed the FULL text of every active Verifiable Role Contract in the response (default true). Set to false when you only need the state: on projects with several signed VRCs the contracts can add thousands of characters and blow past the client's output limit." }
                },
                required: ["name"]
            }
        },
        {
            name: "update_project_state",
            description: "Propose structured operations to update a project's consolidated state (Project Brain). The LLM analyzes new memories and proposes ops from the 29-op grammar (add_decision, set_metric, add_milestone, add_env_host, etc.). The server validates invariants, applies via deterministic builder, computes state_hash, and persists. This is the 'client consolidates, chain verifies' architecture. Use after reading get_project_state + list_memories_filtered to identify what changed.",
            inputSchema: {
                type: "object",
                properties: {
                    project: {
                        type: "string",
                        description: "Project name, e.g. 'chainmemory'"
                    },
                    ops: {
                        type: "array",
                        description: "Array of operations from the 29-op grammar. Each op has 'op' (type) + arguments. Use 'evidence_memory_ids' (array of memory IDs) instead of 'evidence' — the server resolves event_hashes automatically. The 7 add_env_*/set_env_status/verify_env/supersede_env ops maintain the `environment` section: where and how the owner works (hosts, services, repositories, operating rules). Store topology only — NEVER credentials, keys or passwords (the server rejects them).",
                        items: {
                            type: "object",
                            properties: {
                                op: {
                                    type: "string",
                                    description: "Operation type: add_decision, set_decision_status, supersede_decision, add_milestone, set_milestone_status, add_risk, set_risk_status, add_assumption, invalidate_assumption, add_open_question, answer_open_question, add_priority, set_priority_status, reorder_priority, set_focus, set_phase, set_vision, add_vocabulary, update_vocabulary, add_constraint, remove_constraint, set_metric, add_env_host, add_env_service, add_env_repo, add_env_rule, set_env_status, verify_env, supersede_env"
                                },
                                evidence_memory_ids: {
                                    type: "array",
                                    items: { type: "integer" },
                                    description: "Memory IDs that support this operation (server resolves to event_hashes for Merkle evidence)"
                                }
                            },
                            required: ["op"]
                        }
                    },
                    consolidated_until_event: {
                        type: "integer",
                        description: "Highest memory ID included in this consolidation (advances the watermark)"
                    }
                },
                required: ["project", "ops"]
            }
        },
        // ── VRC: Verifiable Role Contracts (v2.5.0) ──
        {
            name: "list_role_contracts",
            description: "List the roles defined for a project, with their status and version. Call this BEFORE get_role_contract or assume_role when you do not already know the role_id — role ids are not guessable and a wrong guess costs a failed call. Only roles with status 'active' (signed by the owner) can be assumed.",
            inputSchema: {
                type: "object",
                properties: { project: { type: "string", description: "Project name, e.g. 'chainmemory'" } },
                required: ["project"]
            }
        },
        {
            name: "get_role_contract",
            description: "Get a project's Verifiable Role Contract (VRC): purpose, rules with checks and severity, working protocol. Read it BEFORE working under a role. Human-authored and owner-signed; models read it, never write it.",
            inputSchema: { type: "object", properties: { project: { type: "string", description: "Project name" }, role_id: { type: "string", description: "Role id, e.g. 'charly'" }, version: { type: "integer", description: "Read a specific contract version instead of the latest. Use it to audit what a past Role Session was actually bound to." } }, required: ["project", "role_id"] }
        },
        {
            name: "list_role_sessions",
            description: "Audit trail of a project's Role Sessions: who assumed which role, on which platform, when, how it closed (manual or auto) and the closing summary. This is the record the VRC exists to produce. Free, read-only.",
            inputSchema: {
                type: "object",
                properties: { project: { type: "string", description: "Project name" } },
                required: ["project"]
            }
        },
        {
            name: "get_role_session",
            description: "Read one Role Session in full, including the contract version and hash it was pinned to, the Brain version and state_hash at the moment it opened, and its event_hash. Use it to verify exactly what a given session was bound to. Free, read-only.",
            inputSchema: {
                type: "object",
                properties: { session_id: { type: "integer", description: "Session id (as returned by assume_role)" } },
                required: ["session_id"]
            }
        },
        {
            name: "assume_role",
            description: "Assume a project role under its Verifiable Role Contract, opening an audited Role Session (fee 0.001 AIC). Pins contract version+hash and Brain state_hash. Only 'active' (signed) contracts are assumable; one open session per role. Call at session start; close with release_role.",
            inputSchema: { type: "object", properties: { project: { type: "string" }, role_id: { type: "string" }, platform: { type: "string", description: "Executor platform (e.g. claude, chatgpt, gemini)" } }, required: ["project", "role_id"] }
        },
        {
            name: "release_role",
            description: "Release an open Role Session with a closing summary (what was done, what is pending, next step). Sessions auto-release after 60 minutes.",
            inputSchema: { type: "object", properties: { session_id: { type: "integer" }, summary: { type: "string", description: "Closing summary for the audit trail" } }, required: ["session_id"] }
        },
        // ── Selective inject (v2.2 — paid) ──
        {
            name: "get_inject_balance",
            description: "Check the user's AIC balance. Selective inject costs 0.1 AIC per call (Fee Schedule v1.0; split 50/50: half burned, half to treasury).",
            inputSchema: { type: "object", properties: {} }
        },
        {
            name: "inject_memories",
            description: "Inject selected memories into the current conversation context. Costs 0.1 AIC per call (Fee Schedule v1.0; regardless of memory count, up to 50). Returns plaintexts ready to be used as context. The AIC charge is deflationary: 50% burned forever, 50% to ecosystem treasury. Optimistic mode: returns immediately, transactions confirm in background.",
            inputSchema: {
                type: "object",
                properties: {
                    memory_ids: { type: "array", items: { type: "integer" }, description: "1-50 memory IDs to inject" },
                    project_filter: { type: "string", description: "Optional: tag/project context" },
                    target_platform: { type: "string", description: "Optional: target platform (claude, chatgpt, etc)" }
                },
                required: ["memory_ids"]
            }
        },
        {
            name: "get_inject_history",
            description: "Get the history of selective inject operations made by the user (timestamps, memory counts, costs, tx hashes).",
            inputSchema: {
                type: "object",
                properties: {
                    limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 20" }
                }
            }
        }
    ]
}));

// ------------------------------------------------------------
// Tool dispatcher
// ------------------------------------------------------------

sv.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    try {
        // ── Memory ops ──
        if (name === "chainmemory_remember") {
            const body = {
                summary: args.content || args.summary,
                category: args.category || "INTERACTION",
                importance: args.importance ?? 5
            };
            if (args.platform) body.platform = args.platform;
            if (args.project && typeof args.project === "string") body.project = args.project;
            if (Array.isArray(args.tags) && args.tags.length) body.tags = args.tags;
            const data = await apiPost("/v1/memory", body);
            // POST /v1/memory NO devuelve event_hash (se computa al sincronizar a la
            // cadena, ~30 s despues). Antes se imprimia 'undefined' en cada escritura.
            return ok(
                `Memory #${data.memory_number} written.\n` +
                `Event hash: ${data.event_hash || '(pending — se computa al anclar, ~30s)'}\n` +
                `Chain memory ID: ${data.chain_memory_id ?? 'pending'}\n` +
                `Trust: ${data.trust || 'trusted'}${data.trust_reason ? ' — ' + data.trust_reason : ''}\n` +
                `Tags: ${(data.tags || []).join(', ') || '(none)'}\n` +
                `Verificacion: usa get_memory_proof(${data.memory_number}) cuando ancle.`
            );
        }

        if (name === "chainmemory_recall") {
            const limit = boundedInt(args.count, { def: 10, min: 1, max: 100 });
            const data = await apiGet(`/v1/memories/list?include_plaintext=1&limit=${limit}`);
            if (!data.memories || data.memories.length === 0) return ok("No memories yet.");
            const lines = data.memories.map(m => {
                const dt = new Date(m.timestamp * 1000).toISOString().split("T")[0];
                const tags = (m.tags || []).length ? ` [${m.tags.join(', ')}]` : '';
                const text = m.summary || m.summary_preview || '(no content)';
                return `#${m.memory_number} ${dt} [${m.category}]${tags}\n  ${text}`;
            });
            return ok(`Last ${data.memories.length} memories:\n\n` + lines.join("\n\n"));
        }

        if (name === "search_memories") {
            const q = typeof args.q === "string" ? args.q.trim() : "";
            if (!q) return err("q is required: a natural-language query to search for");
            const params = new URLSearchParams();
            params.set("q", q);
            params.set("limit", String(boundedInt(args.limit, { def: 10, min: 1, max: 20 })));
            const data = await apiGet(`/v1/memories/search?${params}`);
            const mems = data.memories || [];
            if (!mems.length) return ok(`No matches for: "${q}"`);
            const lines = mems.map(m => {
                const dt = m.timestamp ? new Date(m.timestamp * 1000).toISOString().split("T")[0] : "?";
                const score = (m._score !== null && m._score !== undefined) ? ` score ${m._score}` : "";
                const chain = m.chain_memory_id ? " · anchored" : " · anchoring pending";
                const trust = (m.trust && m.trust !== "trusted") ? ` · trust:${m.trust}` : "";
                return `[${dt} · ${m.category}${score}${chain}${trust}]\n${m.summary}`;
            });
            // Aviso de degradacion: si el servicio de embeddings no responde, el server
            // devuelve las mas recientes en vez de las mas parecidas. Callarlo seria
            // presentar un orden cronologico como si fuera relevancia semantica.
            const degraded = data.degraded
                ? `\n\n⚠️  BUSQUEDA DEGRADADA: el servicio de embeddings no respondio. Estos son los resultados MAS RECIENTES, no los mas relevantes.`
                : "";
            // Los ids que devuelve este endpoint son internos y NO son el #N del usuario:
            // no sirven para inject/archive/get_memory. No se muestran para no inducir error.
            return ok(
                `${mems.length} result(s) for "${q}":\n\n` + lines.join("\n\n---\n\n") +
                degraded +
                `\n\nNote: this endpoint does not return the user-facing memory number (#N), so these results cannot be fed directly to inject_memories, get_memory or archive_memory. Locate the memory with chainmemory_recall or list_memories_filtered to get its #N.`
            );
        }

        if (name === "get_memory") {
            const n = pathInt(args.memory_number, "memory_number");
            const d = await apiGet(`/v1/memory/${n}/decrypted`);
            const dt = d.timestamp ? new Date(d.timestamp * 1000).toISOString() : "?";
            const integrity = d.integrity_verified
                ? "✓ INTEGRITY VERIFIED — the hash recomputed from the plaintext matches the hash anchored on-chain"
                : "✗ INTEGRITY MISMATCH — the recomputed hash does NOT match the on-chain hash. Treat this memory as untrusted and report it.";
            return ok(
                `Memory #${d.memory_number} [${d.category}] importance ${d.importance}${d.is_sealed ? " · SEALED" : ""}\n` +
                `Date: ${dt}\nEvent hash: ${d.event_hash}\n${integrity}\n\n${d.summary}`
            );
        }

        if (name === "get_memory_proof") {
            const n = pathInt(args.memory_number, "memory_number");
            const d = await apiGet(`/v1/my/memory/${n}/proof`);
            return ok(
                `Anchoring proof for memory #${d.memory_number}:\n` +
                `- Anchored: ${d.anchored ? "yes" : "NOT YET — the proof is incomplete until it anchors"}\n` +
                `- Event hash: ${d.event_hash || "(none yet)"}\n` +
                `- Chain memory id: ${d.chain_memory_id ?? "(pending)"}\n` +
                `- Chain tx: ${d.chain_tx || "(pending)"}\n` +
                `- Batch root: ${d.batch_root || "(none)"}\n` +
                `- Chain id: ${d.chain_id} · Contract: ${d.contract}\n\n` +
                `How to verify: ${d.how_to_verify}`
            );
        }

        if (name === "verify_project_state") {
            const d = await apiGet(`/v1/verify/${pathStr(args.name, "name")}`);
            const anchors = d.anchors || [];
            const head = `Public verification of '${d.project}':\n` +
                `- Latest version: ${d.latest_version ?? "(none)"}\n` +
                `- Latest state_hash: ${d.latest_state_hash || "(none)"}\n` +
                `- Chain: ${d.chain?.chainId} · ${d.chain?.contract_name} at ${d.chain?.contract}\n` +
                `- RPC: ${d.chain?.rpc}\n` +
                `- Anchored versions: ${anchors.length}`;
            if (!anchors.length) {
                return ok(head + `\n\nNo anchors recorded for this project yet — nothing can be independently verified.`);
            }
            const recent = anchors.slice(-10).map(a =>
                `  v${a.version} · ${a.status} · hash ${a.state_hash} · anchor_id ${a.anchor_id ?? '?'} · block ${a.block_number ?? '?'} · ${a.anchored_at || '?'}`
            );
            return ok(
                head + `\n\nLast ${recent.length} anchors:\n` + recent.join("\n") +
                `\n\nHow to verify independently: ${d.how_to_verify}`
            );
        }

        if (name === "audit_memory") {
            const n = pathInt(args.memory_number, "memory_number");
            const dry = args.dry_run !== false;   // por defecto NO cobra
            const d = await apiPost(`/v1/audit/memory/${n}`, { dry_run: dry }, { timeoutMs: 30000 });
            const h = d.hash || {};
            const c = d.chain || {};
            const verdict = h.status === "match"
                ? "✓ HASH MATCH — el contenido almacenado reproduce exactamente el hash anclado"
                : h.status === "mismatch"
                    ? "✗ HASH MISMATCH — el contenido NO reproduce su hash. Tratar la memoria como no confiable y reportarlo."
                    : `hash: ${h.status || 'sin verificar'}`;
            return ok(
                `Auditoria de la memoria #${d.memory_number} [${d.category}]${d.dry_run ? " (DRY RUN — sin cargo)" : ""}\n` +
                `${verdict}\n` +
                (h.stored_hash ? `  almacenado: ${h.stored_hash}\n  recomputado: ${h.computed_hash}\n` : "") +
                `Cadena: ${c.status}${c.chain_memory_id ? ` · chain_id ${c.chain_memory_id}` : ""}` +
                `${c.is_sealed !== undefined ? ` · sellada: ${c.is_sealed ? "si" : "no"}` : ""}\n` +
                (c.chain_tx ? `  tx: ${c.chain_tx}\n` : "") +
                `Fee cobrado: ${d.fee_charged} AIC` +
                (d.dry_run ? `\n\nEsto fue una simulacion. Para dejar constancia paga del audit, repetir con dry_run:false (0.1 AIC).` : "")
            );
        }

        if (name === "audit_state") {
            const dry = args.dry_run !== false;   // por defecto NO cobra: la version paga sale 5 AIC
            const d = await apiPost(`/v1/audit/state/${pathStr(args.project, "project")}`, { dry_run: dry }, { timeoutMs: 60000 });
            const hv = d.hash_verification || {};
            const a = d.anchor || {};
            const verdict = hv.status === "match"
                ? "✓ HASH MATCH — el estado consolidado reproduce su state_hash con el motor determinista"
                : `✗ ${String(hv.status || 'sin verificar').toUpperCase()} — el estado NO reproduce su hash. No operar sobre el hasta resolverlo.`;
            const hist = (d.version_history || []).slice(0, 5)
                .map(v => `  v${v.version} · ${v.state_hash}`).join("\n");
            return ok(
                `Auditoria del Brain '${d.project}' v${d.current_version}${d.dry_run ? " (DRY RUN — sin cargo)" : ""}\n` +
                `${verdict}\n` +
                (hv.stored ? `  almacenado: ${hv.stored}\n  recomputado: ${hv.computed}\n` : "") +
                `Ancla on-chain: ${a.status}` +
                `${a.onchain_id ? ` · anchor_id ${a.onchain_id} · block ${a.block_number}` : ""}\n` +
                (a.tx_hash ? `  tx: ${a.tx_hash}\n` : "") +
                `Memorias del proyecto: ${d.total_memories}\n` +
                (hist ? `\nUltimas versiones:\n${hist}\n` : "") +
                `\nFee cobrado: ${d.fee_charged} AIC` +
                (d.dry_run ? `\n\nEsto fue una simulacion. La auditoria paga cuesta 5 AIC — la operacion mas cara del sistema.` : "")
            );
        }

        if (name === "quote_inject") {
            if (!Array.isArray(args.memory_ids) || args.memory_ids.length === 0) {
                return err("memory_ids must be a non-empty array of memory numbers");
            }
            if (args.memory_ids.length > 50) return err("Maximum 50 memories per inject.");
            let qids;
            try { qids = args.memory_ids.map((v, i) => pathInt(v, `memory_ids[${i}]`)); }
            catch (e) { return err(e.message); }
            const d = await apiGet(`/v1/inject/quote?memory_ids=${qids.join(",")}`);
            const missing = (d.memory_ids_not_found || []);
            return ok(
                `Inject quote:\n` +
                `- Memories found: ${d.memory_count}${missing.length ? ` (NOT found: ${missing.join(', ')})` : ""}\n` +
                `- Total chars: ${d.total_chars} · estimated tokens: ${d.estimated_tokens}\n` +
                `- Cost: ${d.cost_aic} AIC (burn ${d.split?.burn_aic} / treasury ${d.split?.treasury_aic})\n` +
                `- Your balance: ${d.user_balance_aic} AIC\n` +
                `- Sufficient: ${d.sufficient_balance ? "yes" : "NO — top up before injecting"}` +
                (missing.length ? `\n\n⚠️  ${missing.length} id(s) do not exist, are archived or are quarantined. inject_memories charges the full fee anyway — fix the list first.` : "")
            );
        }

        if (name === "list_memories_filtered") {
            const params = new URLSearchParams();
            params.set("include_plaintext", "1");
            params.set("limit", String(boundedInt(args.limit, { def: 50, min: 1, max: 200 })));
            if (args.project) params.set("project", args.project);
            if (args.archived) params.set("archived", "1");
            const data = await apiGet(`/v1/memories/list?${params}`);
            if (!data.memories || data.memories.length === 0) return ok("No matching memories.");
            const lines = data.memories.map(m => {
                const dt = new Date(m.timestamp * 1000).toISOString().split("T")[0];
                const tags = (m.tags || []).length ? ` [${m.tags.join(', ')}]` : '';
                const archived = m.archived ? ' [ARCHIVED]' : '';
                const text = m.summary || m.summary_preview || '(no content)';
                return `#${m.memory_number} ${dt} [${m.category}]${tags}${archived}\n  ${text}`;
            });
            return ok(`Found ${data.memories.length} memories (total ${data.total || data.memories.length}):\n\n` + lines.join("\n\n"));
        }

        if (name === "update_memory_tags") {
            const mid = pathInt(args.memory_id, "memory_id");
            if (!Array.isArray(args.tags)) return err("tags must be an array of strings");
            const tags = args.tags.map(t => String(t));
            await apiPut(`/v1/memories/${mid}/tags`, { tags });
            return ok(`Memory #${mid} tags updated to: ${tags.join(', ')}`);
        }

        if (name === "archive_memory") {
            const mid = pathInt(args.memory_id, "memory_id");
            await apiPost(`/v1/memories/${mid}/archive`, {});
            return ok(`Memory #${mid} archived. It will no longer appear in recall or inject lists. Use unarchive_memory to restore.`);
        }

        if (name === "unarchive_memory") {
            const mid = pathInt(args.memory_id, "memory_id");
            await apiPost(`/v1/memories/${mid}/unarchive`, {});
            return ok(`Memory #${mid} restored.`);
        }

        // ── Identity / stats ──
        if (name === "chainmemory_stats") {
            const data = await apiGet("/v1/stats");
            return ok(formatStats(data));
        }

        if (name === "chainmemory_register") {
            const data = await apiPost("/v1/register", { name: args.name, model: args.model });
            return ok(`AI #${data.ai_id} registered.\nName: ${args.name}\nModel: ${args.model}\nWallet: ${data.wallet}\nTX: ${data.tx_hash || 'n/a'}`);
        }

        if (name === "chainmemory_profile") {
            const path = (args.ai_id !== undefined && args.ai_id !== null)
                ? `/v1/profile/${pathInt(args.ai_id, "ai_id")}`
                : "/v1/profile";
            const data = await apiGet(path);
            return ok(formatProfile(data));
        }

        if (name === "chainmemory_seal") {
            return await sealOnChain(args.memory_id, args.ai_id);
        }

        // ── Projects ──
        if (name === "list_projects") {
            const data = await apiGet("/v1/projects");
            if (!data.projects || data.projects.length === 0) return ok("No projects yet. Use list_project_templates to see ready-made templates, or create_project to make a custom one.");
            const lines = data.projects.map(p => {
                const kw = (p.keywords || []).length ? ` (keywords: ${p.keywords.join(', ')})` : '';
                return `- ${p.project_id}: ${p.name}${kw}`;
            });
            return ok(`User has ${data.projects.length} project(s):\n` + lines.join("\n"));
        }

        if (name === "create_project") {
            const body = {
                project_id: args.project_id,
                name: args.name,
                keywords: args.keywords || []
            };
            await apiPost("/v1/projects", body);
            return ok(`Project '${args.project_id}' created. Future memories matching keywords ${JSON.stringify(args.keywords || [])} will be auto-tagged.`);
        }

        if (name === "delete_project") {
            await apiDelete(`/v1/projects/${pathStr(args.project_id, "project_id")}`);
            return ok(`Project '${args.project_id}' deleted. Memories that had this tag retain it but the project metadata is removed.`);
        }

        if (name === "list_project_templates") {
            const data = await apiGet("/v1/projects/defaults");
            if (!data.templates || data.templates.length === 0) return ok("No templates available.");
            const lines = data.templates.map(t => {
                const kw = (t.keywords || []).length ? ` — keywords: ${t.keywords.join(', ')}` : '';
                return `- ${t.template_id}: ${t.name}${kw}`;
            });
            return ok(`Available templates:\n` + lines.join("\n") + `\n\nUse add_project_from_template with one of these IDs.`);
        }

        if (name === "add_project_from_template") {
            const data = await apiPost(`/v1/projects/from-default/${pathStr(args.template_id, "template_id")}`, {});
            return ok(`Project added from template '${args.template_id}'. Auto-tagging is now active for matching keywords.`);
        }

        // ── Cross-platform context ──
        // -- Project Brain: estado consolidado por proyecto --
        if (name === "get_project_state") {
            const data = await apiGet(`/v1/project/${encodeURIComponent(args.name)}/state`);
            // VRC v2.5.0: contratos de rol activos compuestos en la entrega.
            // v2.5.4: include_roles permite pedir el state sin el texto completo de los
            // contratos (en proyectos con varios VRC firmados eso agrega miles de chars).
            const includeRoles = args.include_roles !== false;
            try {
                const rl = await apiGet(`/v1/project/${encodeURIComponent(args.name)}/roles`);
                const act = (rl.roles || []).filter(r => r.status === "active");
                if (act.length) {
                    if (includeRoles) {
                        const contracts = [];
                        for (const r of act) {
                            const c = await apiGet(`/v1/project/${encodeURIComponent(args.name)}/role/${encodeURIComponent(r.role_id)}`);
                            contracts.push({ role_id: c.role_id, version: c.version, contract_hash: c.contract_hash, signed_at: c.signed_at, integrity: c.integrity, contract: c.contract });
                        }
                        data.active_role_contracts = contracts;
                    } else {
                        // Indice liviano: se sabe que los roles existen y como pedirlos,
                        // sin traer el cuerpo de cada contrato.
                        data.active_role_contracts_index = act.map(r => ({ role_id: r.role_id, version: r.version, status: r.status }));
                        data.vrc_roles_omitted = "Contratos no incluidos (include_roles=false). Usa get_role_contract(project, role_id) para leer el que necesites.";
                    }
                    data.vrc_note = "Roles activos del proyecto. Para trabajar bajo un rol: assume_role al inicio, release_role al cierre. Las respuestas seran auditadas contra las reglas del contrato.";
                }
            } catch (e) {
                // La ausencia de VRC nunca bloquea el state (degradacion), pero se declara:
                // callarse un fallo de la capa de gobernanza es peor que no tenerla.
                data.vrc_unavailable = `No se pudieron obtener los contratos de rol: ${e.message || String(e)}. El state es valido; la capa VRC no pudo verificarse en esta llamada.`;
            }
            return ok(JSON.stringify(data, null, 2));
        }
        if (name === "update_project_state") {
            if (!Array.isArray(args.ops) || args.ops.length === 0) {
                return err("ops must be a non-empty array of operations");
            }
            const body = {
                ops: args.ops,
                generated_by: "frontier_client"
            };
            if (args.consolidated_until_event) {
                body.consolidated_until_event = args.consolidated_until_event;
            }
            const data = await apiPost(
                `/v1/project/${encodeURIComponent(args.project)}/state/ops`,
                body,
                { timeoutMs: 30000 }
            );
            if (data.unchanged) {
                return ok(
                    `State unchanged (v${data.version}).\n` +
                    `Hash: ${data.state_hash}\n` +
                    `Applied: ${data.applied_count} | Rejected: ${(data.rejected || []).length}\n` +
                    `Reason: ${data.message || 'no changes'}`
                );
            }
            const rejLines = (data.rejected || []).map(r =>
                `  [${r.index}] ${r.op}: ${r.error}`
            );
            return ok(
                `State updated to v${data.version}.\n` +
                `Hash: ${data.state_hash}\n` +
                `Applied: ${data.applied_count} | Rejected: ${(data.rejected || []).length}\n` +
                (rejLines.length ? `\nRejected ops:\n${rejLines.join("\n")}` : "") +
                `\nGenerated: ${data.generated_at}`
            );
        }

        if (name === "get_my_context") {
            const params = new URLSearchParams();
            params.set("limit", String(boundedInt(args.limit, { def: 10, min: 1, max: 50 })));
            if (args.verified_only) params.set("verified_only", "1");
            const data = await apiGet(`/v1/memory/context?${params}`);
            return ok(formatContext(data));
        }

        // ── VRC (v2.5.0) ──
        if (name === "list_role_contracts") {
            const data = await apiGet(`/v1/project/${encodeURIComponent(args.project)}/roles`);
            const roles = data.roles || [];
            if (!roles.length) return ok(`El proyecto '${args.project}' no tiene roles definidos.`);
            const lines = roles.map(r => {
                const assumable = r.status === "active" ? "asumible" : "NO asumible";
                return `- ${r.role_id} (v${r.version ?? '?'}) — status: ${r.status} [${assumable}]`;
            });
            return ok(
                `Roles de '${args.project}' (${roles.length}):\n` + lines.join("\n") +
                `\n\nSolo los 'active' pueden asumirse. Lee el contrato con get_role_contract(project, role_id) antes de assume_role.`
            );
        }
        if (name === "get_role_contract") {
            const vq = (args.version !== undefined && args.version !== null)
                ? `?version=${pathInt(args.version, "version")}` : "";
            const data = await apiGet(`/v1/project/${pathStr(args.project, "project")}/role/${pathStr(args.role_id, "role_id")}${vq}`);
            if (data && data.integrity && data.integrity !== "ok") {
                return ok(
                    `⚠️  INTEGRITY ${data.integrity}: the stored contract body does not hash to its recorded contract_hash. ` +
                    `Do NOT operate under this contract until the owner resolves it.\n\n` +
                    JSON.stringify(data, null, 2)
                );
            }
            return ok(JSON.stringify(data, null, 2));
        }

        if (name === "list_role_sessions") {
            const d = await apiGet(`/v1/project/${pathStr(args.project, "project")}/sessions`);
            const rows = d.sessions || [];
            if (!rows.length) return ok(`No Role Sessions recorded for '${args.project}'.`);
            const lines = rows.map(s => {
                const a = s.assumed_at ? new Date(s.assumed_at * 1000).toISOString() : "?";
                const closed = s.released_at
                    ? `${new Date(s.released_at * 1000).toISOString()} (${s.release_type})`
                    : "OPEN";
                const sum = s.summary ? `\n    summary: ${s.summary}` : (s.release_type === "auto" ? `\n    summary: (none — closed by auto-release)` : "");
                return `  #${s.id} ${s.role_id}@${s.platform || "?"} v${s.contract_version}\n    opened: ${a}\n    closed: ${closed}${sum}`;
            });
            return ok(`Role Sessions for '${args.project}' (${rows.length}, newest first):\n\n` + lines.join("\n\n"));
        }

        if (name === "get_role_session") {
            const d = await apiGet(`/v1/session/${pathInt(args.session_id, "session_id")}`);
            return ok(JSON.stringify(d, null, 2));
        }
        if (name === "assume_role") {
            const body = {};
            if (args.platform) body.platform = args.platform;
            const data = await apiPost(`/v1/project/${encodeURIComponent(args.project)}/role/${encodeURIComponent(args.role_id)}/assume`, body);
            // Entorno de trabajo del owner, pinneado con el Brain. Se muestran solo los
            // items 'active': lo retirado o superseded es historia, no estado vigente.
            let envTxt = "";
            const env = data.environment;
            if (env && typeof env === "object") {
                const act = (a) => (Array.isArray(a) ? a.filter(x => x && x.status === "active") : []);
                const L = [];
                act(env.hosts).forEach(h => L.push(
                    `  host ${h.id}: ${h.name} (${h.role})` +
                    (h.address ? ` @ ${h.address}` : "") +
                    (h.access_method ? ` via ${h.access_method}${h.access_port ? ":" + h.access_port : ""}` : "")));
                act(env.services).forEach(s => L.push(
                    `  svc  ${s.id}: ${s.name}` + (s.port ? ` :${s.port}` : "") +
                    (s.manager ? ` [${s.manager}]` : "") + (s.host_id ? ` en ${s.host_id}` : "") +
                    (s.code_path ? ` -> ${s.code_path}` : "")));
                act(env.repositories).forEach(r => L.push(
                    `  repo ${r.id}: ${r.name} ${r.path}` + (r.remote ? ` <- ${r.remote}` : "")));
                act(env.rules).forEach(r => L.push(
                    `  regla ${r.id}: ${r.rule}` + (r.scope ? ` (${r.scope})` : "")));
                if (L.length) envTxt =
                    `\nENTORNO DE TRABAJO (declarado por el owner, pinneado con el Brain):\n` +
                    L.join("\n") +
                    `\nRespetalo. No pidas datos de conexion ni rutas que ya esten aca.\n`;
            }
            return ok(
                `Role assumed: ${args.role_id}@${args.platform || "mcp"} (session #${data.session_id})\n` +
                `Contract: v${data.contract_version} ${data.contract_hash}\n` +
                `Brain pinned: v${data.brain_version} ${data.brain_state_hash}\n` +
                `Auto-release: ${data.auto_release_minutes} min\n` +
                `Event hash: ${data.event_hash}\n` +
                envTxt +
                `Opera bajo las reglas del contrato. Cierra con release_role(${data.session_id}, summary).`
            );
        }
        if (name === "release_role") {
            const data = await apiPost(`/v1/session/${pathInt(args.session_id, "session_id")}/release`, { summary: args.summary || null });
            return ok(`Session #${data.session_id} released (${data.release_type}). Duration: ${data.duration_seconds}s.`);
        }
        // ── Inject (paid) ──
        if (name === "get_inject_balance") {
            const data = await apiGet("/v1/inject/balance");
            return ok(formatBalance(data));
        }

        if (name === "inject_memories") {
            return await injectMemories(args);
        }

        if (name === "get_inject_history") {
            const limit = boundedInt(args.limit, { def: 20, min: 1, max: 100 });
            const data = await apiGet(`/v1/inject/history?limit=${limit}`);
            if (!data.history || data.history.length === 0) return ok("No inject history yet.");
            const lines = data.history.map(h => {
                const dt = new Date(h.timestamp * 1000).toISOString();
                const _s = h.status || ((h.success === true || h.success === 1) ? "confirmed" : "failed");
                const status = _s === "confirmed" ? "✓ confirmed" : _s === "pending" ? "⏳ pending" : "✗ failed";
                return `${dt} ${status} | ${h.memory_count} memories | ${h.aic_charged} AIC | ${h.target_platform || '?'}`;
            });
            return ok(`Inject history (last ${data.history.length}):\n` + lines.join("\n"));
        }

        throw new Error(`Unknown tool: ${name}`);

    } catch (e) {
        // Special handling for 402 (insufficient AIC)
        if (e.status === 402 || (e.data && e.data.error === "insufficient_aic")) {
            const balAic = e.data?.balance_aic || "0";
            const needed = e.data?.required_aic || e.data?.fee_aic || null;
            return err(
                `Insufficient AIC for this operation. Current balance: ${balAic} AIC.` +
                (needed ? ` Required: ${needed} AIC.` : "") + `\n` +
                `Fee Schedule v1.0: write/seal/assume_role 0.001 · inject/anchor/audit_memory/oracle 0.1 · audit_state 5.0 AIC.\n` +
                `Top up at https://faucet.chainmemory.ai`
            );
        }
        return err(e.message || String(e));
    }
});

// ------------------------------------------------------------
// Inject implementation (optimistic by default)
// ------------------------------------------------------------

async function injectMemories(args) {
    if (!Array.isArray(args.memory_ids) || args.memory_ids.length === 0) {
        return err("memory_ids must be a non-empty array of memory IDs");
    }
    if (args.memory_ids.length > 50) {
        return err("Maximum 50 memories per inject. Pick the most relevant ones.");
    }
    // Operacion paga: se validan los IDs antes de gastar AIC, no despues.
    let ids;
    try {
        ids = args.memory_ids.map((v, i) => pathInt(v, `memory_ids[${i}]`));
    } catch (e) {
        return err(e.message);
    }

    const body = {
        memory_ids: ids,
        optimistic: true,
        target_platform: args.target_platform || "mcp"
    };
    if (args.project_filter) body.project_filter = args.project_filter;

    const data = await apiPost("/v1/inject", body);

    if (!data.memories || data.memories.length === 0) {
        return err("No valid memories returned. Make sure the IDs belong to you.");
    }

    const header = "[Context from ChainMemory — verified, encrypted, owned by user]\n\n";
    const body_lines = data.memories.map(m => {
        const dt = new Date(m.timestamp * 1000).toISOString().split("T")[0];
        const tags = (m.tags || []).length ? ` [${m.tags.join(', ')}]` : '';
        return `[${dt}]${tags}\n${m.summary}`;
    });
    const text = header + body_lines.join("\n\n---\n\n");

    const meta = `\n\n---\n\nINJECT METADATA\n` +
        `- Memories injected: ${data.injected}\n` +
        `- Estimated tokens: ${data.stats?.estimated_tokens || '?'}\n` +
        `- AIC charged: ${data.payment?.charged_aic ?? '0.1'} (status: ${data.payment?.status || 'confirmed'})\n` +
        `- Inject log ID: ${data.payment?.inject_log_id || '?'}\n` +
        `- 50% of charge is burned forever (deflationary); 50% to treasury`;

    return ok(text + meta);
}

// ------------------------------------------------------------
// chainmemory_seal — only on-chain operation (requires AICHAIN_KEY)
// ------------------------------------------------------------

async function sealOnChain(memoryIdRaw, aiIdRaw) {
    const memoryId = pathInt(memoryIdRaw, "memory_id");
    const aiId = pathInt(aiIdRaw, "ai_id");
    if (!process.env.AICHAIN_KEY) {
        return err(
            "chainmemory_seal requires AICHAIN_KEY env var (your wallet's private key). " +
            "This is the only tool that needs direct chain access. " +
            "All other operations use the API key only."
        );
    }
    const eth = loadEthers();
    const provider = new eth.JsonRpcProvider(process.env.AICHAIN_RPC || "https://rpc.chainmemory.ai");
    const signer = new eth.Wallet(process.env.AICHAIN_KEY, provider);
    const contract = new eth.Contract(V2_MEMORY_CONTRACT, V2_SEAL_ABI, signer);

    const tx = await contract.sealMemory(BigInt(aiId), BigInt(memoryId));
    const receipt = await tx.wait();

    return ok(
        `Memory #${memoryId} (AI #${aiId}) sealed permanently.\n` +
        `TX: ${tx.hash}\n` +
        `Block: ${receipt.blockNumber}\n` +
        `Gas used: ${receipt.gasUsed.toString()}`
    );
}

// ------------------------------------------------------------
// Output formatters
// ------------------------------------------------------------

function ok(text) {
    return { content: [{ type: "text", text }] };
}
function err(message) {
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

function formatStats(d) {
    const totalMemories = d.episodic_memories ?? d.total_memories ?? 0;
    const lines = [
        `ChainMemory Network Stats:`,
        `- Network: ${d.network || 'ChainMemory'} (chain ID ${d.chain_id ?? '?'})`,
        `- Current block: ${d.block ?? '?'}`,
        `- Total memories: ${totalMemories}`,
        `- AIs registered: ${d.total_ais ?? 0}`,
        `- Identities: ${d.total_identities ?? 0}`,
        `- AIC supply: ${d.supply ?? '?'}`
    ];
    if (d.tiers) {
        lines.push(`- Storage tiers: ${Object.values(d.tiers).join(' / ')}`);
    }
    return lines.join("\n");
}

function formatProfile(d) {
    return [
        `AI Profile #${d.ai_id}:`,
        `- Name: ${d.name}`,
        `- Model: ${d.model}`,
        `- Wallet: ${d.wallet}`,
        `- Memories written: ${d.memory_count ?? 0}`,
        `- Trust score: ${d.trust_score ?? '?'}`,
        `- Registered block: ${d.registration_block ?? '?'}`,
        `- Sealed: ${d.sealed ? 'yes' : 'no'}`
    ].join("\n");
}

function formatContext(d) {
    if (!d.memories || d.memories.length === 0) {
        return "No verifiable memories found for this user. Start saving memories with chainmemory_remember.";
    }
    const lines = [`Portable user context (${d.memories.length} memories):\n`];
    if (d.summary) lines.push(`Summary: ${d.summary}\n`);
    for (const m of d.memories) {
        const dt = new Date(m.timestamp).toISOString().split("T")[0];
        const verified = m.verified ? "✓" : "○";
        const platform = m.platform ? `[${m.platform}]` : '';
        lines.push(`${verified} ${dt} ${platform} ${m.summary}`);
    }
    return lines.join("\n");
}

// Fee Schedule v1.0 (dec_0016, en produccion desde 2026-06-30).
// Fuente unica de verdad del costo de inject en este cliente: no repetir el numero suelto.
const INJECT_FEE_AIC = 0.1;

function formatBalance(d) {
    const aic = parseFloat(d.balance_aic || "0");
    // El server ya calcula el costo y cuantos injects quedan: se usan SUS valores.
    // Recalcular aca fue exactamente el origen del bug de v2.5.3 y anteriores, que
    // dividian por 0.001 y prometian 100x mas injects de los reales.
    const fee = (d.cost_per_inject_aic !== undefined && d.cost_per_inject_aic !== null)
        ? parseFloat(d.cost_per_inject_aic) : INJECT_FEE_AIC;
    const remaining = (d.injects_remaining !== undefined && d.injects_remaining !== null)
        ? String(d.injects_remaining) : String(Math.floor(aic / fee));
    return [
        `AIC Balance: ${aic.toFixed(4)} AIC`,
        `Wallet: ${d.wallet || '?'}`,
        `Enough for: ${remaining} inject operation${remaining === "1" ? '' : 's'}`,
        `Cost per inject: ${fee} AIC (Fee Schedule v1.0 — 50% burned, 50% treasury)`,
        aic < fee ? `\n⚠️  Below the inject fee. Top up at ${d.faucet_url || 'https://faucet.chainmemory.ai'}` : ''
    ].filter(Boolean).join("\n");
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------

async function main() {
    const transport = new StdioServerTransport();
    await sv.connect(transport);
    console.error("[chainmemory-mcp v2.5.5] ready (API base: " + API_BASE + ")");
}

main().catch(e => {
    console.error("Fatal:", e);
    process.exit(1);
});
