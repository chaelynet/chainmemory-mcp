// ─────────────────────────────────────────────────────────────────────────────
// test-stdio-regresion.js — el MCP de siempre sigue funcionando igual.
//
// El paso 1 tocó el arranque del servidor: la clave salió de la global, el
// Server pasó a armarse en una fábrica y el módulo dejó de abrir un transporte
// al cargarse. Nada de eso debe cambiar lo que ve un usuario de stdio.
//
// Habla JSON-RPC crudo por stdin/stdout, sin el SDK, para no depender de que el
// SDK esté de acuerdo con el SDK.
//
//   node test-stdio-regresion.js <ruta a server.js>
// ─────────────────────────────────────────────────────────────────────────────
const { spawn } = require("node:child_process");
const path = require("node:path");

const SERVER = process.argv[2] || path.resolve(process.cwd(), "server.js");
const PROTO = "2025-06-18";

function run() {
    return new Promise((resolve, reject) => {
        const env = { ...process.env };
        delete env.CHAINMEMORY_API_KEY;      // tools/list no necesita clave
        delete env.CHAINMEMORY_SEED_PHRASE;

        const hijo = spawn(process.execPath, [SERVER], {
            stdio: ["pipe", "pipe", "pipe"],
            env
        });

        let salida = "";
        let errores = "";
        const respuestas = new Map();
        const timer = setTimeout(() => { hijo.kill(); reject(new Error("timeout: el servidor no respondió en 15 s")); }, 15000);

        hijo.stdout.on("data", (b) => {
            salida += b.toString();
            let corte;
            while ((corte = salida.indexOf("\n")) >= 0) {
                const linea = salida.slice(0, corte).trim();
                salida = salida.slice(corte + 1);
                if (!linea) continue;
                let msg;
                try { msg = JSON.parse(linea); } catch { continue; }
                if (msg.id !== undefined) respuestas.set(msg.id, msg);
                if (respuestas.has(2)) {
                    clearTimeout(timer);
                    hijo.kill();
                    resolve({ respuestas, errores });
                }
            }
        });
        hijo.stderr.on("data", (b) => { errores += b.toString(); });
        hijo.on("error", reject);
        // Si el hijo se muere antes de contestar, el error real está en su stderr:
        // sin esto el test se queda esperando 15 s y dice "timeout", que no explica nada.
        hijo.on("exit", (code) => {
            if (respuestas.has(2)) return;
            clearTimeout(timer);
            reject(new Error(`el servidor terminó con código ${code} sin responder:
${errores.trim() || "(sin stderr)"}`));
        });

        const enviar = (m) => hijo.stdin.write(JSON.stringify(m) + "\n");
        enviar({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
            protocolVersion: PROTO,
            capabilities: {},
            clientInfo: { name: "test-regresion", version: "1.0.0" }
        }});
        enviar({ jsonrpc: "2.0", method: "notifications/initialized" });
        enviar({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    });
}

(async () => {
    const { respuestas, errores } = await run();
    const fallos = [];

    const init = respuestas.get(1);
    if (!init || !init.result) fallos.push("initialize no devolvió resultado");
    else {
        const info = init.result.serverInfo || {};
        const esperada = require(path.resolve(path.dirname(SERVER), "package.json")).version;
        if (info.name !== "chainmemory") fallos.push(`serverInfo.name = ${info.name}, esperaba chainmemory`);
        if (info.version !== esperada) fallos.push(`serverInfo.version = ${info.version}, esperaba ${esperada}`);
        console.log(`initialize   : ${info.name} v${info.version} (protocolo ${init.result.protocolVersion})`);
    }

    const lista = respuestas.get(2);
    if (!lista || !lista.result || !Array.isArray(lista.result.tools)) fallos.push("tools/list no devolvió herramientas");
    else {
        const nombres = lista.result.tools.map(t => t.name);
        console.log(`tools/list   : ${nombres.length} herramientas`);
        if (nombres.length !== 36) fallos.push(`tools/list devolvió ${nombres.length} herramientas, esperaba 36`);
        for (const n of ["chainmemory_remember", "chainmemory_seal", "chainmemory_open_sealed", "chainmemory_new_seed", "get_project_state"]) {
            if (!nombres.includes(n)) fallos.push(`falta la herramienta ${n} en stdio`);
        }
    }

    if (!/ready \(API base:/.test(errores)) fallos.push("no apareció la línea 'ready' en stderr");
    else console.log(`stderr       : ${errores.trim().split("\n").pop()}`);

    if (fallos.length) {
        console.error("\nFALLA la regresión de stdio:");
        for (const f of fallos) console.error("  - " + f);
        process.exit(1);
    }
    console.log("\nOK: stdio se comporta igual que antes del cambio.");
})().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
