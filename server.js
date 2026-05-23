#!/usr/bin/env node
// ============================================================
// ChainMemory MCP Server v2.2.0
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
// 17 tools available:
//
//   Memory ops:
//     - chainmemory_remember           — write memory
//     - chainmemory_recall             — recall last N memories
//     - list_memories_filtered         — filter by project/tags/archived
//     - update_memory_tags             — change tags on a memory
//     - archive_memory                 — hide from recall
//     - unarchive_memory               — restore archived
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
//   Selective inject (paid, optimistic):
//     - get_inject_balance             — check AIC balance
//     - inject_memories                — inject memories to current chat (0.001 AIC)
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
// Server setup
// ------------------------------------------------------------

const sv = new Server(
    { name: "chainmemory", version: "2.2.0" },
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
            description: "Recall the user's recent memories (most recent first). Returns plaintext for the owning user. Use at conversation start to provide context continuity.",
            inputSchema: {
                type: "object",
                properties: {
                    count: { type: "integer", minimum: 1, maximum: 100, description: "Number of memories (default 10)" }
                }
            }
        },
        {
            name: "list_memories_filtered",
            description: "List memories with filtering by project tag, archived status. Returns memories with metadata + plaintext for owner.",
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
                    memory_id: { type: "integer", description: "Memory ID" },
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
                    memory_id: { type: "integer", description: "Memory ID to archive" }
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
                    memory_id: { type: "integer", description: "Memory ID to restore" }
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
                    memory_id: { type: "integer", description: "Memory ID to seal" },
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

        // ── Selective inject (v2.2 — paid) ──
        {
            name: "get_inject_balance",
            description: "Check the user's AIC balance. Selective inject costs 0.001 AIC per call (split 50/50: half burned, half to treasury).",
            inputSchema: { type: "object", properties: {} }
        },
        {
            name: "inject_memories",
            description: "Inject selected memories into the current conversation context. Costs 0.001 AIC per call (regardless of memory count, up to 50). Returns plaintexts ready to be used as context. The AIC charge is deflationary: 50% burned forever, 50% to ecosystem treasury. Optimistic mode: returns immediately, transactions confirm in background.",
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
                summary: args.summary,
                category: args.category || "INTERACTION",
                importance: args.importance ?? 5
            };
            if (args.platform) body.platform = args.platform;
            const data = await apiPost("/v1/memory", body);
            return ok(`Memory #${data.memory_id} written.\nEvent hash: ${data.event_hash}\nChain memory ID: ${data.chain_memory_id ?? 'pending'}\nTags: ${(data.tags || []).join(', ') || '(none)'}`);
        }

        if (name === "chainmemory_recall") {
            const limit = args.count || 10;
            const data = await apiGet(`/v1/memories/list?include_plaintext=1&limit=${limit}`);
            if (!data.memories || data.memories.length === 0) return ok("No memories yet.");
            const lines = data.memories.map(m => {
                const dt = new Date(m.timestamp * 1000).toISOString().split("T")[0];
                const tags = (m.tags || []).length ? ` [${m.tags.join(', ')}]` : '';
                const text = m.summary || m.summary_preview || '(no content)';
                return `#${m.id} ${dt} [${m.category}]${tags}\n  ${text}`;
            });
            return ok(`Last ${data.memories.length} memories:\n\n` + lines.join("\n\n"));
        }

        if (name === "list_memories_filtered") {
            const params = new URLSearchParams();
            params.set("include_plaintext", "1");
            params.set("limit", String(args.limit || 50));
            if (args.project) params.set("project", args.project);
            if (args.archived) params.set("archived", "1");
            const data = await apiGet(`/v1/memories/list?${params}`);
            if (!data.memories || data.memories.length === 0) return ok("No matching memories.");
            const lines = data.memories.map(m => {
                const dt = new Date(m.timestamp * 1000).toISOString().split("T")[0];
                const tags = (m.tags || []).length ? ` [${m.tags.join(', ')}]` : '';
                const archived = m.archived ? ' [ARCHIVED]' : '';
                const text = m.summary || m.summary_preview || '(no content)';
                return `#${m.id} ${dt} [${m.category}]${tags}${archived}\n  ${text}`;
            });
            return ok(`Found ${data.memories.length} memories (total ${data.total || data.memories.length}):\n\n` + lines.join("\n\n"));
        }

        if (name === "update_memory_tags") {
            const data = await apiPut(`/v1/memories/${args.memory_id}/tags`, { tags: args.tags });
            return ok(`Memory #${args.memory_id} tags updated to: ${args.tags.join(', ')}`);
        }

        if (name === "archive_memory") {
            await apiPost(`/v1/memories/${args.memory_id}/archive`, {});
            return ok(`Memory #${args.memory_id} archived. It will no longer appear in recall or inject lists. Use unarchive_memory to restore.`);
        }

        if (name === "unarchive_memory") {
            await apiPost(`/v1/memories/${args.memory_id}/unarchive`, {});
            return ok(`Memory #${args.memory_id} restored.`);
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
            const path = args.ai_id ? `/v1/profile/${args.ai_id}` : "/v1/profile";
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
            await apiDelete(`/v1/projects/${args.project_id}`);
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
            const data = await apiPost(`/v1/projects/from-default/${args.template_id}`, {});
            return ok(`Project added from template '${args.template_id}'. Auto-tagging is now active for matching keywords.`);
        }

        // ── Cross-platform context ──
        if (name === "get_my_context") {
            const params = new URLSearchParams();
            params.set("limit", String(args.limit || 10));
            if (args.verified_only) params.set("verified_only", "1");
            const data = await apiGet(`/v1/context?${params}`);
            return ok(formatContext(data));
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
            const limit = args.limit || 20;
            const data = await apiGet(`/v1/inject/history?limit=${limit}`);
            if (!data.history || data.history.length === 0) return ok("No inject history yet.");
            const lines = data.history.map(h => {
                const dt = new Date(h.timestamp * 1000).toISOString();
                const status = h.success === 1 ? "✓ confirmed" : h.success === 2 ? "⏳ pending" : "✗ failed";
                return `${dt} ${status} | ${h.memory_count} memories | ${h.aic_charged} AIC | ${h.target_platform || '?'}`;
            });
            return ok(`Inject history (last ${data.history.length}):\n` + lines.join("\n"));
        }

        throw new Error(`Unknown tool: ${name}`);

    } catch (e) {
        // Special handling for 402 (insufficient AIC)
        if (e.status === 402 || (e.data && e.data.error === "insufficient_aic")) {
            const balAic = e.data?.balance_aic || "0";
            return err(
                `Insufficient AIC. Current balance: ${balAic} AIC. Need 0.001 AIC.\n` +
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

    const body = {
        memory_ids: args.memory_ids,
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
        `- AIC charged: ${data.payment?.charged_aic || '0.001'} (status: ${data.payment?.status || 'confirmed'})\n` +
        `- Inject log ID: ${data.payment?.inject_log_id || '?'}\n` +
        `- 50% of charge is burned forever (deflationary); 50% to treasury`;

    return ok(text + meta);
}

// ------------------------------------------------------------
// chainmemory_seal — only on-chain operation (requires AICHAIN_KEY)
// ------------------------------------------------------------

async function sealOnChain(memoryId, aiId) {
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
        const dt = new Date(m.timestamp * 1000).toISOString().split("T")[0];
        const verified = m.verified ? "✓" : "○";
        const platform = m.platform ? `[${m.platform}]` : '';
        lines.push(`${verified} ${dt} ${platform} ${m.summary}`);
    }
    return lines.join("\n");
}

function formatBalance(d) {
    const aic = parseFloat(d.balance_aic || "0");
    const enoughForInjects = Math.floor(aic / 0.001);
    return [
        `AIC Balance: ${aic.toFixed(4)} AIC`,
        `Enough for: ${enoughForInjects} inject operation${enoughForInjects === 1 ? '' : 's'}`,
        `Cost per inject: 0.001 AIC (50% burned, 50% treasury)`,
        aic < 0.001 ? `\n⚠️  Below minimum. Top up at https://faucet.chainmemory.ai` : ''
    ].filter(Boolean).join("\n");
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------

async function main() {
    const transport = new StdioServerTransport();
    await sv.connect(transport);
    console.error("[chainmemory-mcp v2.2.0] ready (API base: " + API_BASE + ")");
}

main().catch(e => {
    console.error("Fatal:", e);
    process.exit(1);
});
