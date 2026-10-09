// ─────────────────────────────────────────────────────────────────────────────
// test-brief.js — get_project_brief compara contra la version correcta.
//
// La vista la arma el servidor; lo que hace el MCP es elegir el since: la ultima
// version que le entrego a esta clave para ese proyecto, guardada solo en esta
// maquina y sin la clave adentro. En el remoto no guarda nada. Se prueba contra
// una API falsa que anota cada pedido, con un HOME temporal para no tocar el real.
//
//   node test-brief.js
// (se ejecuta desde el directorio del MCP, o con CM_MCP=<ruta a server.js>)
// ─────────────────────────────────────────────────────────────────────────────
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const fallos = [];
const check = (cond, msg) => { if (!cond) fallos.push(msg); };

(async () => {
    // ── la API falsa ─────────────────────────────────────────────────────────
    let modo = "ok";
    let version = 96;
    const pedidos = [];
    const stub = http.createServer((req, res) => {
        pedidos.push({ url: req.url, clave: req.headers["x-api-key"], cliente: req.headers["x-cm-client"] });
        const u = new URL(req.url, "http://x");
        const since = u.searchParams.get("since");
        const completo = u.searchParams.get("level") === "full" && modo !== "sin-full";
        const responderBase = (code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
        // nivel completo: la API real agrega level y sensitive_lines; una API vieja los ignora
        const responder = (code, body) => responderBase(code, code === 200 && completo
            ? { ...body, level: "full", sensitive_lines: ["linea sensible 1", "linea sensible 2"], text: "COMPLETO " + body.text }
            : code === 200 ? { ...body, level: "public" } : body);
        if (modo === "sin-ruta") return responder(404, { error: "Not found", method: "GET", path: u.pathname });
        if (modo === "sin-estado") return responder(404, { error: "project state not found" });
        if (since !== null && (modo === "since-400" || Number(since) > version)) return responder(400, { error: `since must be a version between 1 and ${version}` });
        const task = u.searchParams.get("task");
        if (task !== null && modo !== "sin-tarea") {
            if (task === "pri_9999") return responder(404, { error: `priority ${task} not found` });
            return responder(200, { project: "x", version, state_hash: "0x", task, budget: Number(u.searchParams.get("budget")), lang: "en", text: `TAREA ${task} v${version}` });
        }
        responder(200, {
            project: decodeURIComponent(u.pathname.split("/")[3]), version, state_hash: "0x" + "ab".repeat(32),
            since: since === null ? version - 1 : Number(since), budget: Number(u.searchParams.get("budget")),
            lang: u.searchParams.get("lang") || "en", text: `BRIEF v${version} since ${since === null ? "default" : since}`
        });
    });
    await new Promise(r => stub.listen(0, "127.0.0.1", r));

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cm-brief-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.CHAINMEMORY_API_BASE = `http://127.0.0.1:${stub.address().port}`;
    process.env.CHAINMEMORY_API_KEY = "aic_clave-de-prueba-que-no-debe-quedar-en-disco";
    delete process.env.CHAINMEMORY_SEED_PHRASE;
    const archivo = path.join(home, ".chainmemory", "brief-since.json");

    const { dispatchTool, requestContext, TOOLS } = require(process.env.CM_MCP || path.resolve(process.cwd(), "server.js"));
    const brief = async (args) => {
        pedidos.length = 0;
        const r = await dispatchTool({ params: { name: "get_project_brief", arguments: args } });
        return { texto: r.content[0].text, error: r.isError === true, pedidos: pedidos.map(p => p.url) };
    };

    check(TOOLS.some(t => t.name === "get_project_brief"), "get_project_brief no esta en la lista de herramientas");
    check(TOOLS.some(t => t.name === "get_project_state"), "get_project_state desaparecio");

    // 1. primera vez: sin since, y recuerda la 96
    let r = await brief({ name: "mi proyecto" });
    check(!r.error && r.texto === "BRIEF v96 since default", `primera vez: ${r.texto}`);
    check(r.pedidos.length === 1 && r.pedidos[0] === "/v1/project/mi%20proyecto/inject?budget=7000", `primera vez pidio ${r.pedidos.join(" | ")}`);
    check(fs.existsSync(archivo), "no se creo el archivo de versiones leidas");
    const crudo = fs.existsSync(archivo) ? fs.readFileSync(archivo, "utf8") : "";
    check(!crudo.includes("clave-de-prueba") && !crudo.includes("mi proyecto"), "el archivo contiene la clave o el nombre del proyecto");
    check(Object.values(JSON.parse(crudo || "{}")).join() === "96", `el archivo no guarda la version 96: ${crudo}`);
    console.log(`primera vez  : sin since, recuerda v96 (${crudo.length} bytes, sin la clave)`);

    // 2. segunda vez: since = 96
    r = await brief({ name: "mi proyecto" });
    check(r.texto === "BRIEF v96 since 96" && /&since=96$/.test(r.pedidos[0]), `segunda vez: ${r.texto} (${r.pedidos.join(" | ")})`);

    // 3. el Brain avanza: compara contra la 96 y recuerda la 97
    version = 97;
    r = await brief({ name: "mi proyecto", lang: "es", budget: 12000 });
    check(r.texto === "BRIEF v97 since 96" && r.pedidos[0] === "/v1/project/mi%20proyecto/inject?budget=12000&lang=es&since=96", `v97: ${r.texto} (${r.pedidos.join(" | ")})`);
    r = await brief({ name: "mi proyecto" });
    check(r.texto === "BRIEF v97 since 97", `despues de v97: ${r.texto}`);
    console.log(`siguientes   : compara con la ultima entregada (96, luego 97)`);

    // 4. la recordada no sirve (400): reintenta sin since
    modo = "since-400";
    r = await brief({ name: "mi proyecto" });
    check(!r.error && r.texto === "BRIEF v97 since default" && r.pedidos.length === 2 && /&since=97$/.test(r.pedidos[0]) && !/since/.test(r.pedidos[1]),
        `400 con la recordada: ${r.texto} (${r.pedidos.join(" | ")})`);
    // 5. un since explicito invalido no se reintenta: es un error de quien llama
    r = await brief({ name: "mi proyecto", since: 5 });
    check(r.error && /since must be/.test(r.texto) && r.pedidos.length === 1, `since explicito invalido: ${r.texto} (${r.pedidos.length} pedidos)`);
    modo = "ok";
    r = await brief({ name: "mi proyecto", since: 90 });
    check(r.texto === "BRIEF v97 since 90", `since explicito: ${r.texto}`);
    console.log(`since        : recordado invalido reintenta sin since; explicito invalido da error`);

    // 6. otro proyecto no hereda la version de este
    r = await brief({ name: "otro" });
    check(!/since=/.test(r.pedidos[0]), `otro proyecto heredo un since: ${r.pedidos[0]}`);
    // 7. remoto: nunca manda since recordado y no escribe nada
    const antes = fs.readFileSync(archivo, "utf8");
    pedidos.length = 0;
    const remoto = await requestContext.run({ apiKey: "aic_otra-clave" }, () =>
        dispatchTool({ params: { name: "get_project_brief", arguments: { name: "mi proyecto" } } }));
    check(remoto.content[0].text === "BRIEF v97 since default" && !/since=/.test(pedidos[0].url) && pedidos[0].clave === "aic_otra-clave",
        `remoto: ${remoto.content[0].text} (${pedidos.map(p => p.url).join(" | ")})`);
    check(fs.readFileSync(archivo, "utf8") === antes, "el remoto escribio en el archivo de versiones");
    console.log(`aislamiento  : otro proyecto sin since; el remoto ni lee ni escribe el archivo`);

    // 8. parametros: budget acotado, lang invalido rechazado sin pedir nada, name obligatorio
    r = await brief({ name: "otro", budget: 999999 });
    check(/budget=50000/.test(r.pedidos[0]), `budget enorme: ${r.pedidos[0]}`);
    r = await brief({ name: "otro", budget: 10 });
    check(/budget=1000(&|$)/.test(r.pedidos[0]), `budget chico: ${r.pedidos[0]}`);
    r = await brief({ name: "otro", lang: "fr" });
    check(r.error && /lang must be/.test(r.texto) && r.pedidos.length === 0, `lang=fr: ${r.texto}`);
    r = await brief({});
    check(r.error && /name must be/.test(r.texto) && r.pedidos.length === 0, `sin name: ${r.texto}`);

    // 9. errores del servidor
    modo = "sin-ruta";
    r = await brief({ name: "otro" });
    check(r.error && /use get_project_state/.test(r.texto), `API sin la ruta: ${r.texto}`);
    modo = "sin-estado";
    r = await brief({ name: "otro" });
    check(r.error && /project state not found/.test(r.texto), `proyecto sin estado: ${r.texto}`);
    modo = "ok";
    console.log(`errores      : lang y name validados aca; sin ruta sugiere get_project_state`);

    // 9b. modo tarea: pide task, nunca since, y no mueve la version recordada
    const antesTarea = fs.readFileSync(archivo, "utf8");
    r = await brief({ name: "mi proyecto", task: "pri_0015", lang: "es" });
    check(!r.error && r.texto === "TAREA pri_0015 v97" && r.pedidos.length === 1 && r.pedidos[0] === "/v1/project/mi%20proyecto/inject?budget=7000&lang=es&task=pri_0015",
        `tarea: ${r.texto} (${r.pedidos.join(" | ")})`);
    check(fs.readFileSync(archivo, "utf8") === antesTarea, "el modo tarea movio la version recordada");
    for (const malo of ["risk_0045", "pri_15", "pri_0015&budget=1", 15]) {
        r = await brief({ name: "mi proyecto", task: malo });
        check(r.error && /task must be a priority id/.test(r.texto) && r.pedidos.length === 0, `task=${JSON.stringify(malo)}: ${r.texto} (${r.pedidos.length} pedidos)`);
    }
    r = await brief({ name: "mi proyecto", task: "pri_9999" });
    check(r.error && /priority pri_9999 not found/.test(r.texto), `tarea inexistente: ${r.texto}`);
    modo = "sin-tarea";
    r = await brief({ name: "mi proyecto", task: "pri_0015" });
    check(r.error && /does not serve task briefs yet/.test(r.texto), `API que ignora task: ${r.texto}`);
    modo = "ok";
    console.log(`tarea        : pide task sin since, no mueve la version; valida el id; detecta una API vieja`);

    // 9c. nivel completo, sin habilitar en esta maquina: no se pide nada
    r = await brief({ name: "mi proyecto", level: "full" });
    check(r.error && /disabled on this machine/.test(r.texto) && /CHAINMEMORY_ALLOW_FULL=1/.test(r.texto) && r.pedidos.length === 0, `completo sin habilitar: ${r.texto.slice(0, 80)} (${r.pedidos.length} pedidos)`);
    r = await brief({ name: "mi proyecto", level: "todo" });
    check(r.error && /level must be/.test(r.texto) && r.pedidos.length === 0, `level invalido: ${r.texto}`);
    r = await brief({ name: "mi proyecto", level: "public" });
    check(!r.error && !/level=/.test(r.pedidos[0]) && !/full level/.test(r.texto), `level public explicito: como siempre (${r.pedidos[0]})`);
    check(/^chainmemory-mcp \d+\.\d+\.\d+ stdio$/.test(pedidos[0].cliente || ""), `cada pedido dice que cliente es (${pedidos[0].cliente})`);

    // 9d. habilitado: se recarga el modulo con CHAINMEMORY_ALLOW_FULL=1
    process.env.CHAINMEMORY_ALLOW_FULL = "1";
    const ruta = require.resolve(process.env.CM_MCP || path.resolve(process.cwd(), "server.js"));
    delete require.cache[ruta];
    const m2 = require(ruta);
    const brief2 = async (args, ctx) => {
        pedidos.length = 0;
        const llamar = () => m2.dispatchTool({ params: { name: "get_project_brief", arguments: args } });
        const res2 = ctx ? await m2.requestContext.run(ctx, llamar) : await llamar();
        return { texto: res2.content[0].text, error: res2.isError === true, pedidos: pedidos.map(p => p.url) };
    };
    r = await brief2({ name: "mi proyecto", level: "full" });
    check(!r.error && /&level=full/.test(r.pedidos[0]) && /^COMPLETO BRIEF/.test(r.texto) && /\(full level: 2 sensitive lines included; ChainMemory logged this request\)$/.test(r.texto),
        `completo habilitado: pide level=full y avisa cuantas lineas sensibles salieron (${r.pedidos[0]})`);
    r = await brief2({ name: "mi proyecto", level: "full", task: "pri_0015" });
    check(!r.error && /&level=full&task=pri_0015$/.test(r.pedidos[0]) && /full level: 2 sensitive lines/.test(r.texto), `completo + tarea: ${r.pedidos[0]}`);
    r = await brief2({ name: "mi proyecto", level: "full" }, { apiKey: "aic_remota" });
    check(r.error && /not available on the remote endpoint/.test(r.texto) && r.pedidos.length === 0, `remoto: el nivel completo no existe aunque la maquina lo habilite (${r.pedidos.length} pedidos)`);
    modo = "sin-full";
    r = await brief2({ name: "mi proyecto", level: "full" });
    check(r.error && /does not serve the full level yet/.test(r.texto), `API que ignora level: ${r.texto}`);
    modo = "ok";
    delete process.env.CHAINMEMORY_ALLOW_FULL;
    console.log(`completo     : sin habilitar no pide nada; habilitado avisa y cuenta; el remoto nunca; detecta una API vieja`);

    // 10. archivo roto: se ignora y se reescribe
    fs.writeFileSync(archivo, "{roto");
    r = await brief({ name: "mi proyecto" });
    check(!r.error && !/since=/.test(r.pedidos[0]) && JSON.parse(fs.readFileSync(archivo, "utf8")), `archivo roto: ${r.texto}`);
    check(!fs.readdirSync(path.dirname(archivo)).some(f => f.endsWith(".tmp")), "quedo un temporal sin renombrar");
    console.log(`archivo roto : se ignora, el brief sale y el archivo se rehace`);

    // Se cierran las conexiones y se deja terminar el proceso solo: en Windows,
    // process.exit con sockets de fetch a medio cerrar dispara una asercion de
    // libuv aunque el test haya pasado.
    stub.closeAllConnections();
    await new Promise(r => stub.close(r));
    fs.rmSync(home, { recursive: true, force: true });
    if (fallos.length) {
        console.error("\nFALLA get_project_brief:");
        for (const f of fallos) console.error("  - " + f);
        process.exitCode = 1;
        return;
    }
    console.log("\nOK: get_project_brief elige bien contra que version comparar.");
})().catch(e => { console.error("Fatal:", e.stack || e.message); process.exitCode = 1; });
