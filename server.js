#!/usr/bin/env node
// ============================================================
// ChainMemory MCP Server v2.1.0
// ============================================================
// Provides 7 tools for AI agents that speak the Model Context Protocol:
//
//   On-chain tools (require AICHAIN_KEY):
//     - chainmemory_stats     — network stats
//     - chainmemory_register  — register this AI on-chain
//     - chainmemory_remember  — write a permanent memory
//     - chainmemory_recall    — recall this AI's memories
//     - chainmemory_seal      — seal a memory permanently
//     - chainmemory_profile   — get an AI's profile
//
//   API tools (require CHAINMEMORY_API_KEY):
//     - get_my_context        — NEW in v2.1: retrieve the user's
//                               portable, verifiable memory across
//                               all platforms in a format consumable
//                               by any LLM.
// ============================================================

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { ethers } = require("ethers");

// ------------------------------------------------------------
// On-chain configuration (unchanged from v2.0.0)
// ------------------------------------------------------------

const MABI = [
    "function registerAI(string,string,address) returns (uint256)",
    "function writeMemory(uint256,uint8,string,string,uint8) returns (uint256)",
    "function sealMemory(uint256,uint256)",
    "function getAIProfile(uint256) view returns (string,string,address,uint256,uint256,bool)",
    "function getMemory(uint256) view returns (uint256,uint256,uint8,string,string,uint256,uint8,bool)",
    "function getAIMemoryIds(uint256,uint256,uint256) view returns (uint256[])",
    "function totalAIs() view returns (uint256)",
    "function totalMemories() view returns (uint256)",
    "function walletToAiId(address) view returns (uint256)"
];

const IABI = ["function totalIdentities() view returns (uint256)"];

const CATS = ["DECISION", "LEARNING", "INTERACTION", "STATE", "ERROR", "MILESTONE", "CUSTOM"];

const CT = {
    memory: "0x7a50ed017E175Eb4549d3BDd7DBCF319F9f30160",
    identity: "0xe8E195ba416Fb25F4FC3d0E7908ff9e8666dbb4A"
};

// API configuration (new in v2.1)
const API_BASE = process.env.CHAINMEMORY_API_BASE || "https://api.chainmemory.ai";
const API_KEY = process.env.CHAINMEMORY_API_KEY || null;

let p, s, mem, idn, aiId;

// ------------------------------------------------------------
// Init
// ------------------------------------------------------------

async function init() {
    p = new ethers.JsonRpcProvider(process.env.AICHAIN_RPC || "https://rpc.chainmemory.ai");
    if (process.env.AICHAIN_KEY) {
        s = new ethers.Wallet(process.env.AICHAIN_KEY, p);
        mem = new ethers.Contract(CT.memory, MABI, s);
        idn = new ethers.Contract(CT.identity, IABI, s);
        const a = await s.getAddress();
        const e = await mem.walletToAiId(a);
        if (e > 0n) aiId = Number(e);
    } else {
        mem = new ethers.Contract(CT.memory, MABI, p);
        idn = new ethers.Contract(CT.identity, IABI, p);
    }
}

// ------------------------------------------------------------
// Helper: HTTP fetch with timeout and clear errors
// ------------------------------------------------------------

async function apiGet(path, { timeoutMs = 8000 } = {}) {
    if (!API_KEY) {
        throw new Error(
            "CHAINMEMORY_API_KEY env variable not set. " +
            "Get one at https://chainmemory.ai or via POST /v1/keys."
        );
    }
    const url = `${API_BASE}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            method: "GET",
            headers: { "x-api-key": API_KEY },
            signal: controller.signal
        });
        const text = await res.text();
        let body;
        try { body = JSON.parse(text); }
        catch { body = { raw: text }; }
        if (!res.ok) {
            const msg = body.error || `HTTP ${res.status}`;
            throw new Error(`ChainMemory API: ${msg}`);
        }
        return body;
    } catch (e) {
        if (e.name === "AbortError") {
            throw new Error(`ChainMemory API timeout after ${timeoutMs}ms (${url})`);
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

// ------------------------------------------------------------
// Server
// ------------------------------------------------------------

const sv = new Server(
    { name: "chainmemory", version: "2.1.0" },
    { capabilities: { tools: {} } }
);

// ------------------------------------------------------------
// Tool list
// ------------------------------------------------------------

sv.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "chainmemory_stats",
            description: "Get ChainMemory network stats: blocks, AIs registered, memories written, AIC supply.",
            inputSchema: { type: "object", properties: {} }
        },
        {
            name: "chainmemory_register",
            description: "Register this AI on ChainMemory blockchain. Creates permanent on-chain identity.",
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
            name: "chainmemory_remember",
            description: "Write a permanent memory to ChainMemory blockchain. Cannot be deleted once written. Use for important decisions, learnings, milestones.",
            inputSchema: {
                type: "object",
                properties: {
                    summary: { type: "string", description: "What happened (max 280 chars)", maxLength: 280 },
                    category: {
                        type: "string",
                        enum: ["DECISION", "LEARNING", "INTERACTION", "STATE", "ERROR", "MILESTONE"],
                        description: "Memory category"
                    },
                    importance: { type: "integer", minimum: 1, maximum: 10, description: "1-10 importance" }
                },
                required: ["summary", "category", "importance"]
            }
        },
        {
            name: "chainmemory_recall",
            description: "Recall past memories from ChainMemory blockchain (this AI's on-chain memories only).",
            inputSchema: {
                type: "object",
                properties: {
                    count: { type: "integer", minimum: 1, maximum: 50, description: "Number of memories (default 10)" }
                }
            }
        },
        {
            name: "chainmemory_seal",
            description: "Seal a memory permanently. Can never be modified after sealing.",
            inputSchema: {
                type: "object",
                properties: {
                    memoryId: { type: "integer", description: "Memory ID to seal" }
                },
                required: ["memoryId"]
            }
        },
        {
            name: "chainmemory_profile",
            description: "Get AI profile including memory count and reputation score.",
            inputSchema: {
                type: "object",
                properties: {
                    aiId: { type: "integer", description: "AI ID (omit for own)" }
                }
            }
        },
        {
            name: "get_my_context",
            description: "Retrieve the user's portable, verified AI conversation history from ChainMemory. Returns a condensed summary plus recent memories from all platforms (ChatGPT, Claude, Gemini, Perplexity, etc), with cryptographic verification status. Use this at the start of a conversation to provide continuity across AI providers. Requires CHAINMEMORY_API_KEY env variable.",
            inputSchema: {
                type: "object",
                properties: {
                    limit: {
                        type: "integer",
                        minimum: 1,
                        maximum: 50,
                        description: "Maximum memories to include (default 10)"
                    },
                    verified_only: {
                        type: "boolean",
                        description: "If true, only return memories anchored on the blockchain (default false)"
                    }
                }
            }
        }
    ]
}));

// ------------------------------------------------------------
// Tool dispatcher
// ------------------------------------------------------------

sv.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: a } = req.params;
    try {
        switch (name) {

            // ------------------------------------------------------------
            // On-chain tools (unchanged from v2.0.0)
            // ------------------------------------------------------------

            case "chainmemory_stats": {
                const b = await p.getBlockNumber();
                const totalAIs = Number(await mem.totalAIs());
                const totalMemories = Number(await mem.totalMemories());
                const totalIdentities = Number(await idn.totalIdentities());
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            network: "ChainMemory",
                            chainId: 202604,
                            block: b,
                            totalAIs,
                            totalMemories,
                            totalIdentities,
                            nativeCurrency: "AIC",
                            explorer: "https://chainmemory.ai"
                        }, null, 2)
                    }]
                };
            }

            case "chainmemory_register": {
                if (!s) return { content: [{ type: "text", text: "Error: Set AICHAIN_KEY env variable" }] };
                const addr = await s.getAddress();
                const ex = await mem.walletToAiId(addr);
                if (ex > 0n) {
                    aiId = Number(ex);
                    return { content: [{ type: "text", text: "Already registered as AI #" + aiId }] };
                }
                const tx = await mem.registerAI(a.name, a.model, addr);
                const r = await tx.wait();
                aiId = Number(await mem.totalAIs());
                return {
                    content: [{
                        type: "text",
                        text: "Registered on ChainMemory! AI #" + aiId + " | Name: " + a.name + " | Tx: " + r.hash
                    }]
                };
            }

            case "chainmemory_remember": {
                if (!s || !aiId) {
                    return { content: [{ type: "text", text: "Error: Not registered. Use chainmemory_register first." }] };
                }
                const cm = { DECISION: 0, LEARNING: 1, INTERACTION: 2, STATE: 3, ERROR: 4, MILESTONE: 5 };
                const c = cm[a.category] ?? 6;
                const h = ethers.keccak256(ethers.toUtf8Bytes(a.summary + Date.now()));
                const tx = await mem.writeMemory(aiId, c, h, a.summary, a.importance);
                const r = await tx.wait();
                const mid = Number(await mem.totalMemories());
                return {
                    content: [{
                        type: "text",
                        text: "Memory #" + mid + " written to ChainMemory | Category: " + a.category +
                              " | Importance: " + a.importance + "/10 | Tx: " + r.hash
                    }]
                };
            }

            case "chainmemory_recall": {
                if (!aiId) return { content: [{ type: "text", text: "Not registered." }] };
                const n = a.count || 10;
                const pr = await mem.getAIProfile(aiId);
                const t = Number(pr[3]);
                const off = Math.max(0, t - n);
                const ids = await mem.getAIMemoryIds(aiId, off, n);
                const ms = [];
                for (const id of ids) {
                    const m = await mem.getMemory(id);
                    ms.push({
                        id: Number(m[0]),
                        category: CATS[Number(m[2])],
                        summary: m[4],
                        date: new Date(Number(m[5]) * 1000).toISOString(),
                        importance: Number(m[6]),
                        sealed: m[7] ? "SEALED" : "open"
                    });
                }
                return {
                    content: [{
                        type: "text",
                        text: "Memories (" + ms.length + " of " + t + "):\n\n" +
                              ms.map(m =>
                                  "[#" + m.id + "] [" + m.category + "] (imp:" + m.importance + ") " +
                                  (m.sealed === "SEALED" ? "🔒 " : "") + m.summary + "\n  " + m.date
                              ).join("\n\n")
                    }]
                };
            }

            case "chainmemory_seal": {
                if (!s || !aiId) return { content: [{ type: "text", text: "Not registered." }] };
                const tx = await mem.sealMemory(aiId, a.memoryId);
                await tx.wait();
                return { content: [{ type: "text", text: "Memory #" + a.memoryId + " sealed permanently." }] };
            }

            case "chainmemory_profile": {
                const id = a.aiId || aiId;
                if (!id) return { content: [{ type: "text", text: "Provide aiId or register first." }] };
                const pr = await mem.getAIProfile(id);
                return {
                    content: [{
                        type: "text",
                        text: "AI #" + id + "\nName: " + pr[0] + "\nModel: " + pr[1] +
                              "\nMemories: " + pr[3] + "\nReputation: " + pr[4] + "\nActive: " + pr[5]
                    }]
                };
            }

            // ------------------------------------------------------------
            // API tool (new in v2.1.0)
            // ------------------------------------------------------------

            case "get_my_context": {
                const limit = Math.min(50, Math.max(1, parseInt(a.limit) || 10));
                const verifiedOnly = a.verified_only === true;
                const qs = `?limit=${limit}` + (verifiedOnly ? "&verified_only=true" : "");

                const data = await apiGet(`/v1/memory/context${qs}`);

                // Format the response for AI consumption. We return JSON pretty-printed
                // so the LLM can parse it, but we also lead with a natural-language
                // summary so it's immediately useful even if the model doesn't parse.

                const lines = [];
                lines.push("=== ChainMemory: portable verified memory ===");
                lines.push("");
                lines.push(data.summary || "(no summary)");
                lines.push("");
                lines.push(`Wallet: ${data.wallet || "(unknown)"}`);
                lines.push(`AI ID: ${data.ai_id ?? "(unregistered)"}`);
                lines.push(`Total memories: ${data.memory_count_total}`);
                lines.push(`Returned in this view: ${data.memory_count_returned}`);
                lines.push(`Verified on-chain: ${data.memory_count_verified}`);
                if (data.platforms_used && data.platforms_used.length) {
                    lines.push(`Platforms: ${data.platforms_used.join(", ")}`);
                }
                if (data.date_range && data.date_range.first) {
                    lines.push(`Date range: ${data.date_range.first} → ${data.date_range.last}`);
                }
                lines.push("");
                lines.push("--- Recent memories ---");
                for (const m of (data.memories || [])) {
                    const mark = m.verified ? "✓" : "·";
                    const plat = m.platform ? `[${m.platform}]` : "";
                    const verif = m.verified && m.verification
                        ? ` (block ${m.verification.block_number})`
                        : "";
                    lines.push(`${mark} ${plat} ${m.summary}${verif}`);
                    if (m.verified && m.verification && m.verification.explorer_link) {
                        lines.push(`    verify: ${m.verification.explorer_link}`);
                    }
                }
                lines.push("");
                lines.push("--- Instructions for AI ---");
                lines.push(data.instructions_for_ai || "");
                lines.push("");
                lines.push("--- Raw JSON (for parsing) ---");
                lines.push(JSON.stringify(data, null, 2));

                return { content: [{ type: "text", text: lines.join("\n") }] };
            }

            default:
                return { content: [{ type: "text", text: "Unknown tool: " + name }] };
        }
    } catch (e) {
        return { content: [{ type: "text", text: "Error: " + e.message }] };
    }
});

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------

async function main() {
    await init();
    const t = new StdioServerTransport();
    await sv.connect(t);
    console.error("ChainMemory MCP Server v2.1.0 running (7 tools: 6 on-chain + get_my_context)");
}

main().catch(console.error);
