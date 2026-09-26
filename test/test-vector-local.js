// ─────────────────────────────────────────────────────────────────────────────
// test-vector-local.js — el vector de busqueda con el motor propio (cm-embed.js).
//
//   a. Baja el modelo de models.chainmemory.ai a una carpeta vacia, lo verifica
//      contra el hash anclado y calcula los 18 textos de referencia: coseno
//      >= 0.9999 contra el vector que calculo el SERVIDOR (referencia-vectores.json).
//   b. Un byte cambiado en el modelo guardado: se detecta, se baja de nuevo y el
//      archivo queda reparado.
//   c. El MCP entero por stdio contra una API de mentira (no toca produccion):
//      - con boveda: remember sealed manda el blob Y el vector; search manda el
//        vector (POST) y no el texto, y abre la memoria sellada aca;
//      - sin boveda: search va por el camino de siempre (GET con el texto), la
//        sellada se muestra como sellada y NO se baja ningun modelo.
//
//   node test/test-vector-local.js
// ─────────────────────────────────────────────────────────────────────────────
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const RAIZ = path.resolve(__dirname, "..");
const SERVER = path.join(RAIZ, "server.js");
const FRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

let fallas = 0;
const check = (cond, texto) => { console.log(`${cond ? "OK  " : "MAL "} ${texto}`); if (!cond) fallas++; };
const cos = (a, b) => { let n = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { n += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return n / Math.sqrt(na * nb); };
const temporal = (nombre) => fs.mkdtempSync(path.join(os.tmpdir(), nombre));

// Carga cm-embed.js en un proceso hijo con otra carpeta de modelo: el modulo
// guarda su estado por proceso, y cada caso tiene que empezar de cero.
function enHijo(dirModelos, codigo) {
    return new Promise((resolve, reject) => {
        const h = spawn(process.execPath, ["-e", codigo], {
            cwd: RAIZ, env: { ...process.env, CHAINMEMORY_MODELS_DIR: dirModelos }, stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "", errOut = "";
        h.stdout.on("data", (b) => (out += b));
        h.stderr.on("data", (b) => (errOut += b));
        h.on("close", (c) => (c === 0 ? resolve(JSON.parse(out)) : reject(new Error(errOut || `salio con ${c}`))));
    });
}

// ── API de mentira ──────────────────────────────────────────────────────────
function apiFalsa() {
    const pedidos = [];
    let blob = null;
    const srv = http.createServer((req, res) => {
        let cuerpo = "";
        req.on("data", (b) => (cuerpo += b));
        req.on("end", () => {
            const url = new URL(req.url, "http://x");
            const json = cuerpo ? JSON.parse(cuerpo) : null;
            pedidos.push({ metodo: req.method, ruta: url.pathname, q: url.searchParams.get("q"), cuerpo: json });
            const responder = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
            if (req.method === "POST" && url.pathname === "/v1/memory/sealed") {
                blob = json.blob_b64;
                return responder({ memory_number: 7, memory_id: 7, scheme: "sealed", searchable: Array.isArray(json.embedding), tags: [] });
            }
            if (url.pathname === "/v1/memories/search") {
                return responder({ count: 1, memories: [{ id: 99, scheme: "sealed", blob_b64: blob, summary: "", category: "INTERACTION", timestamp: 1790000000, _score: 0.91, chain_memory_id: 1, trust: "trusted" }] });
            }
            responder({});
        });
    });
    return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, pedidos, base: `http://127.0.0.1:${srv.address().port}` })));
}

// ── el MCP por stdio, JSON-RPC crudo ────────────────────────────────────────
function mcp(env) {
    const h = spawn(process.execPath, [SERVER], { cwd: RAIZ, env, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "", id = 0;
    const esperando = new Map();
    h.stdout.on("data", (b) => {
        buf += b;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
            const linea = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!linea) continue;
            const m = JSON.parse(linea);
            if (m.id !== undefined && esperando.has(m.id)) { esperando.get(m.id)(m); esperando.delete(m.id); }
        }
    });
    const pedir = (method, params) => new Promise((resolve, reject) => {
        const n = ++id;
        const t = setTimeout(() => reject(new Error(`sin respuesta a ${method}`)), 180000);
        esperando.set(n, (m) => { clearTimeout(t); resolve(m); });
        h.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
    });
    return {
        async iniciar() {
            await pedir("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "prueba", version: "1" } });
            h.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
        },
        async herramienta(name, args) {
            const r = await pedir("tools/call", { name, arguments: args });
            return (r.result && r.result.content || []).map((c) => c.text).join("\n");
        },
        cerrar() { h.kill(); },
    };
}

(async () => {
    const referencia = JSON.parse(fs.readFileSync(path.join(__dirname, "referencia-vectores.json"), "utf8")).casos;

    // ── a. descarga real + 18 textos contra el servidor ─────────────────────
    const dirA = temporal("cm-modelo-");
    const a = await enHijo(dirA, `
        const e = require("./cm-embed.js"); const fs = require("fs");
        const ref = JSON.parse(fs.readFileSync("test/referencia-vectores.json", "utf8")).casos;
        (async () => {
            const t0 = Date.now(); const emb = await e.crearEmbedder();
            if (!emb) { console.log(JSON.stringify({ error: e.motivoNoDisponible() })); return; }
            const seg = (Date.now() - t0) / 1000; const vs = [];
            for (const c of ref) vs.push(await emb.embed(c.texto));
            console.log(JSON.stringify({ seg, vs, carpeta: e.carpetaModelo() }));
        })();`);
    check(!a.error, `modelo bajado de models.chainmemory.ai y verificado (${a.error || a.seg.toFixed(1) + " s"})`);
    if (!a.error) {
        const sims = a.vs.map((v, i) => cos(v, referencia[i].vector)).sort((x, y) => x - y);
        check(sims[0] >= 0.9999, `18 textos contra el vector del SERVIDOR: peor coseno ${sims[0].toFixed(7)}`);
        const hashes = require(path.join(RAIZ, "cm-embed.js")).HASHES_MODELO;
        for (const [nombre, h] of Object.entries(hashes)) {
            const f = path.join(a.carpeta, ...nombre.split("/"));
            check(fs.existsSync(f) && crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex") === h,
                `guardado en disco con el hash anclado: ${nombre}`);
        }
    }

    // ── b. modelo alterado en disco ─────────────────────────────────────────
    const onnxA = path.join(a.carpeta || dirA, "onnx", "model_fp16.onnx");
    const bueno = fs.readFileSync(onnxA);
    const malo = Buffer.from(bueno); malo[malo.length >> 1] ^= 1;
    fs.writeFileSync(onnxA, malo);
    const b = await enHijo(dirA, `
        const e = require("./cm-embed.js");
        (async () => { const emb = await e.crearEmbedder(); const v = emb ? await emb.embed("hola") : null;
            console.log(JSON.stringify({ ok: !!emb, largo: v ? v.length : 0 })); })();`);
    const reparado = fs.readFileSync(onnxA).equals(bueno);
    check(b.ok && b.largo === 384 && reparado, "un byte cambiado en el modelo guardado: se detecto, se bajo de nuevo y quedo reparado");

    // ── c. el MCP por stdio ─────────────────────────────────────────────────
    const api = await apiFalsa();
    const base = { ...process.env, CHAINMEMORY_API_BASE: api.base, CHAINMEMORY_API_KEY: "aic_prueba" };

    // con boveda
    const con = mcp({ ...base, CHAINMEMORY_SEED_PHRASE: FRASE, CHAINMEMORY_MODELS_DIR: dirA });
    await con.iniciar();
    const secreto = "La receta secreta de la abuela lleva nuez moscada y se hornea a fuego lento.";
    const rRem = await con.herramienta("chainmemory_remember", { summary: secreto, sealed: true });
    const escrito = api.pedidos.find((p) => p.ruta === "/v1/memory/sealed");
    check(escrito && Array.isArray(escrito.cuerpo.embedding) && escrito.cuerpo.embedding.length === 384 && escrito.cuerpo.blob_b64,
        "con boveda, remember sealed manda el blob cifrado y el vector de 384");
    check(escrito && !JSON.stringify(escrito.cuerpo).includes("nuez moscada"), "el texto no viaja en claro al guardar");
    check(/Searchable: yes/.test(rRem), "la respuesta dice que la memoria sellada se puede buscar");
    api.pedidos.length = 0;
    const consulta = "ingrediente especial de la comida de la abuela";
    const rBus = await con.herramienta("search_memories", { q: consulta });
    const porVector = api.pedidos.find((p) => p.metodo === "POST" && p.ruta === "/v1/memories/search");
    check(porVector && Array.isArray(porVector.cuerpo.query_embedding) && porVector.cuerpo.query_embedding.length === 384,
        "con boveda, search manda el vector de la consulta (POST)");
    check(!api.pedidos.some((p) => p.q) && !JSON.stringify(api.pedidos).includes("abuela"), "el texto de la consulta no salio de la maquina");
    check(rBus.includes("nuez moscada") && /never left this machine/.test(rBus), "la memoria sellada se abrio aca y se avisa que la consulta no salio");
    con.cerrar();

    // sin boveda
    const dirVacia = temporal("cm-sin-boveda-");
    api.pedidos.length = 0;
    const sin = mcp({ ...base, CHAINMEMORY_MODELS_DIR: dirVacia });
    await sin.iniciar();
    const rSin = await sin.herramienta("search_memories", { q: consulta });
    check(api.pedidos.some((p) => p.metodo === "GET" && p.q === consulta) && !api.pedidos.some((p) => p.metodo === "POST"),
        "sin boveda, search va por el camino de siempre (GET con el texto)");
    check(/\[sealed — set CHAINMEMORY_SEED_PHRASE/.test(rSin), "sin boveda, una sellada se muestra como sellada, no vacia");
    check(fs.readdirSync(dirVacia).length === 0, "sin boveda no se bajo ningun modelo");
    sin.cerrar();
    api.srv.close();

    for (const d of [dirA, dirVacia]) fs.rmSync(d, { recursive: true, force: true });
    console.log(fallas ? `\n${fallas} FALLAS` : "\nOK: el MCP calcula el vector con el motor propio, solo con boveda, y la consulta no sale de la maquina.");
    process.exit(fallas ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.stack || e); process.exit(1); });
