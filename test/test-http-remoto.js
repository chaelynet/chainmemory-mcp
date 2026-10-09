// ─────────────────────────────────────────────────────────────────────────────
// test-http-remoto.js — el endpoint remoto, de punta a punta y por HTTP de verdad.
//
// El test de claves concurrentes prueba el despachador. Este prueba lo que
// realmente va a correr: el proceso completo, con el transporte del SDK en el
// medio. Importa porque el aislamiento se apoya en que el contexto de la request
// sobreviva todo el camino que hace el SDK hasta el handler de la herramienta.
// Eso no se supone: se mide.
//
// Levanta una API falsa, arranca http-server.js apuntado a ella y comprueba:
//   1. N usuarios simultáneos, cada uno con su clave, sin cruzarse
//   2. sin X-API-Key → 401
//   3. Origin ajeno → 403 (DNS rebinding)
//   4. la bóveda ciega no existe ni se puede invocar
//   5. sealed:true falla y no escribe nada
//   6. ruta equivocada → 404, cuerpo gigante → 413
//
//   node test/test-http-remoto.js
// ─────────────────────────────────────────────────────────────────────────────
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

const N = 15;
const fallos = [];
const check = (cond, msg) => { if (!cond) fallos.push(msg); };
const RAIZ = path.resolve(__dirname, "..");

// ── API falsa ───────────────────────────────────────────────────────────────
function apiFalsa() {
    const estado = { vistas: [], escrituras: [] };
    const pendientes = [];
    let sueltas = false;

    const srv = http.createServer((req, res) => {
        const clave = req.headers["x-api-key"] || "(sin clave)";
        const responder = (obj) => {
            const c = JSON.stringify(obj);
            res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(c) });
            res.end(c);
        };

        if (req.url.startsWith("/v1/stats")) {
            estado.vistas.push(clave);
            const enviar = () => responder({ network: clave, chain_id: 202604, block: 1, episodic_memories: 0 });
            // La primera tanda se contesta al revés del orden de llegada, para que el
            // entrelazado sea real y no un accidente del scheduler.
            if (sueltas) return enviar();
            pendientes.push(enviar);
            if (pendientes.length === N) {
                sueltas = true;
                setImmediate(() => { while (pendientes.length) pendientes.pop()(); });
            }
            return;
        }
        if (req.url.startsWith("/v1/memory")) {
            let cuerpo = "";
            req.on("data", c => cuerpo += c);
            req.on("end", () => {
                estado.escrituras.push({ clave, cuerpo });
                responder({ memory_number: 1, id: 1, cost_aic: "0.001" });
            });
            return;
        }
        responder({ ok: true, ruta: req.url });
    });
    return { srv, estado };
}

// ── cliente MCP mínimo por HTTP ─────────────────────────────────────────────
function pedir(base, cuerpo, { clave, origin, headers = {}, crudo } = {}) {
    return new Promise((resolve, reject) => {
        const datos = crudo !== undefined ? crudo : JSON.stringify(cuerpo);
        const u = new URL(base);
        const req = http.request({
            hostname: u.hostname, port: u.port, path: u.pathname, method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                "Content-Length": Buffer.byteLength(datos),
                ...(clave ? { "x-api-key": clave } : {}),
                ...(origin ? { "Origin": origin } : {}),
                ...headers
            }
        }, (res) => {
            let texto = "";
            res.on("data", c => texto += c);
            res.on("end", () => resolve({ status: res.statusCode, texto, json: interpretar(texto) }));
        });
        req.on("error", reject);
        req.end(datos);
    });
}

// La respuesta puede venir como JSON pelado o como stream SSE: las dos son válidas
// según la spec, así que el test acepta las dos.
function interpretar(texto) {
    const t = texto.trim();
    if (!t) return null;
    if (t.startsWith("{")) { try { return JSON.parse(t); } catch { return null; } }
    for (const linea of t.split("\n")) {
        if (linea.startsWith("data:")) {
            try { return JSON.parse(linea.slice(5).trim()); } catch { /* sigue */ }
        }
    }
    return null;
}

function arrancarServidor(apiBase, puerto) {
    return new Promise((resolve, reject) => {
        const hijo = spawn(process.execPath, [path.join(RAIZ, "http-server.js")], {
            cwd: RAIZ,
            env: {
                ...process.env,
                CHAINMEMORY_API_BASE: apiBase,
                CM_MCP_PORT: String(puerto),
                CM_MCP_HOST: "127.0.0.1",
                CM_MCP_ALLOWED_HOSTS: `127.0.0.1:${puerto},localhost:${puerto}`,
                CM_MCP_ALLOWED_ORIGINS: "https://mcp.chainmemory.ai",
                CHAINMEMORY_API_KEY: "",
                CHAINMEMORY_SEED_PHRASE: ""
            }
        });
        let log = "";
        const t = setTimeout(() => reject(new Error("el servidor HTTP no arrancó:\n" + log)), 15000);
        hijo.stdout.on("data", (b) => {
            log += b.toString();
            if (/escuchando en/.test(log)) { clearTimeout(t); resolve({ hijo, log }); }
        });
        hijo.stderr.on("data", (b) => { log += b.toString(); });
        hijo.on("exit", (c) => { clearTimeout(t); reject(new Error(`el servidor murió (código ${c}):\n${log}`)); });
    });
}

(async () => {
    const { srv, estado } = apiFalsa();
    await new Promise(r => srv.listen(0, "127.0.0.1", r));
    const apiBase = `http://127.0.0.1:${srv.address().port}`;

    const puerto = 3100 + Math.floor(Math.random() * 400);
    const { hijo } = await arrancarServidor(apiBase, puerto);
    const url = `http://127.0.0.1:${puerto}/mcp`;

    const llamar = (clave, nombre, args = {}, extra = {}) => pedir(url, {
        jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: nombre, arguments: args }
    }, { clave, ...extra });

    try {
        // ── 1. N usuarios simultáneos ───────────────────────────────────────
        const claves = Array.from({ length: N }, (_, i) => `clave-http-${String(i).padStart(2, "0")}`);
        const res = await Promise.all(claves.map(c => llamar(c, "chainmemory_stats")));

        for (let i = 0; i < N; i++) {
            const texto = (res[i].json && res[i].json.result && res[i].json.result.content[0].text) || res[i].texto;
            check(res[i].status === 200, `${claves[i]} recibió HTTP ${res[i].status}`);
            check(texto.includes(claves[i]), `${claves[i]} no recibió su propia clave: ${String(texto).slice(0, 90)}`);
            const ajenas = claves.filter((c, j) => j !== i && texto.includes(c));
            check(ajenas.length === 0, `${claves[i]} vio claves ajenas: ${ajenas.join(", ")}`);
        }
        check(new Set(estado.vistas).size === N, `la API vio ${new Set(estado.vistas).size} claves distintas, esperaba ${N}`);
        console.log(`concurrencia : ${N} usuarios por HTTP, ${new Set(estado.vistas).size} claves distintas, ` +
                    `${fallos.length ? fallos.length + " problemas" : "ninguna cruzada"}`);

        // ── 2. sin clave ────────────────────────────────────────────────────
        const sinClave = await pedir(url, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, {});
        check(sinClave.status === 401, `sin X-API-Key devolvió ${sinClave.status}, esperaba 401`);
        check(/X-API-Key/.test(sinClave.texto), "el 401 no explica que falta X-API-Key");

        // ── 3. Origin ajeno ─────────────────────────────────────────────────
        const ajeno = await llamar("clave-cualquiera", "chainmemory_stats", {}, { origin: "https://sitio-malicioso.com" });
        check(ajeno.status === 403, `un Origin ajeno devolvió ${ajeno.status}, esperaba 403`);
        const propio = await llamar("clave-origen-propio", "chainmemory_stats", {}, { origin: "https://mcp.chainmemory.ai" });
        check(propio.status === 200, `el Origin propio devolvió ${propio.status}, esperaba 200`);
        console.log(`origen       : ajeno 403, propio 200, sin clave 401`);

        // ── 4. la bóveda no existe ──────────────────────────────────────────
        const listado = await pedir(url, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, { clave: "k" });
        const nombres = ((listado.json && listado.json.result && listado.json.result.tools) || []).map(t => t.name);
        check(nombres.length === 9, `el endpoint publica ${nombres.length} herramientas, esperaba 9`);
        for (const v of ["chainmemory_seal", "chainmemory_open_sealed", "chainmemory_new_seed"]) {
            check(!nombres.includes(v), `${v} aparece publicada en el endpoint remoto`);
            const r = await llamar("k", v);
            const texto = JSON.stringify(r.json || r.texto);
            check(/Unknown tool/.test(texto), `${v} no fue rechazada al invocarla: ${texto.slice(0, 90)}`);
        }
        const remember = ((listado.json.result.tools) || []).find(t => t.name === "chainmemory_remember");
        check(remember && !("sealed" in (remember.inputSchema.properties || {})),
            "chainmemory_remember sigue declarando el parámetro sealed en el remoto");
        check(remember && !/Pass sealed:true/.test(remember.description),
            "la descripción de chainmemory_remember sigue ofreciendo sealed:true en el remoto");
        const brief = ((listado.json.result.tools) || []).find(t => t.name === "get_project_brief");
        check(brief && !/remembers/.test(brief.description) && /nothing is remembered/.test(brief.description),
            "get_project_brief promete en el remoto recordar la version leida, y el remoto no guarda nada");
        check(brief && !("level" in brief.inputSchema.properties) && !/FULL LEVEL|level "full"/.test(brief.description),
            "get_project_brief ofrece el nivel completo en el remoto, que atiende clientes de terceros");
        console.log(`bóveda       : ${nombres.length} herramientas publicadas, las 3 de la bóveda ni listadas ni invocables`);

        // ── 5. sealed:true no escribe nada ──────────────────────────────────
        const antes = estado.escrituras.length;
        const sellado = await llamar("clave-sellado", "chainmemory_remember", { summary: "no debería escribirse", sealed: true });
        const textoSellado = JSON.stringify(sellado.json || sellado.texto);
        check(/not available on the remote|Unknown tool/i.test(textoSellado),
            `sealed:true no dio un error claro: ${textoSellado.slice(0, 120)}`);
        check(estado.escrituras.length === antes,
            `sealed:true escribió ${estado.escrituras.length - antes} memoria(s): tendría que no escribir nada`);
        console.log(`sellado      : rechazado con explicación y sin escribir nada`);

        // ── 6. ruta y tamaño ────────────────────────────────────────────────
        const otraRuta = await pedir(`http://127.0.0.1:${puerto}/otra`, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { clave: "k" });
        check(otraRuta.status === 404, `una ruta que no existe devolvió ${otraRuta.status}, esperaba 404`);
        const gigante = await pedir(url, null, { clave: "k", crudo: "x".repeat(1024 * 1024 + 1024) });
        check(gigante.status === 413, `un cuerpo de más de 1 MB devolvió ${gigante.status}, esperaba 413`);
        const salud = await new Promise((resolve) => {
            http.get(`http://127.0.0.1:${puerto}/health`, (r) => {
                let t = ""; r.on("data", c => t += c); r.on("end", () => resolve({ status: r.statusCode, t }));
            });
        });
        check(salud.status === 200 && /"status":"ok"/.test(salud.t), "/health no responde ok");
        console.log(`bordes       : ruta inexistente 404, cuerpo >1 MB 413, /health ok`);
    } finally {
        hijo.kill();
        srv.close();
    }

    if (fallos.length) {
        console.error("\nFALLA:");
        for (const f of fallos) console.error("  - " + f);
        process.exit(1);
    }
    console.log("\nOK: el endpoint remoto aísla a cada usuario, valida el origen y no expone la bóveda.");
})().catch(e => { console.error("Fatal:", e.message || e); process.exit(1); });
