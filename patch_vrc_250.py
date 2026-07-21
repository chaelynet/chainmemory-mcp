#!/usr/bin/env python3
# patch_vrc_250.py — MCP v2.5.0 (2026-07-21)
# 1) get_project_state compone contratos de rol ACTIVOS en la entrega
#    (el body vive SOLO en role_contracts: referencia si, residencia no)
# 2) Tools nuevos: get_role_contract, assume_role, release_role
# 3) Unifica versiones a 2.5.0
p = "/root/dev/chainmemory-mcp/server.js"
src = open(p, encoding="utf-8").read()
def rep(old, new, n=1):
    global src
    c = src.count(old)
    assert c == n, "ANCLA FALLO (x%d, esperaba %d): %r" % (c, n, old[:70])
    src = src.replace(old, new, n)

# D) versiones
rep("// ChainMemory MCP Server v2.2.0", "// ChainMemory MCP Server v2.5.0")
rep('{ name: "chainmemory", version: "2.4.0" },', '{ name: "chainmemory", version: "2.5.0" },')
rep('console.error("[chainmemory-mcp v2.4.0] ready', 'console.error("[chainmemory-mcp v2.5.0] ready')
rep("// 18 tools available:", "// 21 tools available:")

# A) get_project_state: componer VRC activos
rep('''        if (name === "get_project_state") {
            const data = await apiGet(`/v1/project/${encodeURIComponent(args.name)}/state`);
            return ok(JSON.stringify(data, null, 2));
        }''',
'''        if (name === "get_project_state") {
            const data = await apiGet(`/v1/project/${encodeURIComponent(args.name)}/state`);
            // VRC v2.5.0: contratos de rol activos compuestos en la entrega.
            try {
                const rl = await apiGet(`/v1/project/${encodeURIComponent(args.name)}/roles`);
                const act = (rl.roles || []).filter(r => r.status === "active");
                if (act.length) {
                    const contracts = [];
                    for (const r of act) {
                        const c = await apiGet(`/v1/project/${encodeURIComponent(args.name)}/role/${encodeURIComponent(r.role_id)}`);
                        contracts.push({ role_id: c.role_id, version: c.version, contract_hash: c.contract_hash, signed_at: c.signed_at, integrity: c.integrity, contract: c.contract });
                    }
                    data.active_role_contracts = contracts;
                    data.vrc_note = "Roles activos del proyecto. Para trabajar bajo un rol: assume_role al inicio, release_role al cierre. Las respuestas seran auditadas contra las reglas del contrato.";
                }
            } catch (e) { /* ausencia de VRC nunca bloquea el state (degradacion) */ }
            return ok(JSON.stringify(data, null, 2));
        }''')

# B) definiciones de tools (antes de la seccion Selective inject)
rep('''        // ── Selective inject (v2.2 — paid) ──''',
'''        // ── VRC: Verifiable Role Contracts (v2.5.0) ──
        {
            name: "get_role_contract",
            description: "Get a project's Verifiable Role Contract (VRC): purpose, rules with checks and severity, working protocol. Read it BEFORE working under a role. Human-authored and owner-signed; models read it, never write it.",
            inputSchema: { type: "object", properties: { project: { type: "string", description: "Project name" }, role_id: { type: "string", description: "Role id, e.g. 'charly'" } }, required: ["project", "role_id"] }
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
        // ── Selective inject (v2.2 — paid) ──''')

# C) handlers (antes de la seccion Inject del dispatcher)
rep('''        // ── Inject (paid) ──''',
'''        // ── VRC (v2.5.0) ──
        if (name === "get_role_contract") {
            const data = await apiGet(`/v1/project/${encodeURIComponent(args.project)}/role/${encodeURIComponent(args.role_id)}`);
            return ok(JSON.stringify(data, null, 2));
        }
        if (name === "assume_role") {
            const body = {};
            if (args.platform) body.platform = args.platform;
            const data = await apiPost(`/v1/project/${encodeURIComponent(args.project)}/role/${encodeURIComponent(args.role_id)}/assume`, body);
            return ok(
                `Role assumed: ${args.role_id}@${args.platform || "mcp"} (session #${data.session_id})\\n` +
                `Contract: v${data.contract_version} ${data.contract_hash}\\n` +
                `Brain pinned: v${data.brain_version} ${data.brain_state_hash}\\n` +
                `Auto-release: ${data.auto_release_minutes} min\\n` +
                `Event hash: ${data.event_hash}\\n` +
                `Opera bajo las reglas del contrato. Cierra con release_role(${data.session_id}, summary).`
            );
        }
        if (name === "release_role") {
            const data = await apiPost(`/v1/session/${args.session_id}/release`, { summary: args.summary || null });
            return ok(`Session #${data.session_id} released (${data.release_type}). Duration: ${data.duration_seconds}s.`);
        }
        // ── Inject (paid) ──''')

open(p, "w", encoding="utf-8").write(src)
print("OK: patch 2.5.0 aplicado (%d bytes)" % len(src))
