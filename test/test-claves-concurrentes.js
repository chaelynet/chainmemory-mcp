// ─────────────────────────────────────────────────────────────────────────────
// test-claves-concurrentes.js — dos usuarios a la vez no se cruzan.
//
// Es el test que decide si el MCP remoto se puede publicar. En stdio hay un
// proceso por usuario y nada de esto importa; en un endpoint remoto un mismo
// proceso atiende a muchos al mismo tiempo, y si la clave quedara en una
// variable compartida un usuario leería las memorias de otro. Ese sería el peor
// fallo posible de este sistema, así que se prueba, no se supone.
//
// El test levanta una API falsa que devuelve la clave que recibió, y responde
// EN ORDEN INVERSO al de llegada, a propósito: si las requests no se
// entrelazaran de verdad, el test pasaría sin probar nada.
//
//   node test-claves-concurrentes.js
// (se ejecuta desde el directorio del MCP, o con CM_MCP=<ruta a server.js>)
// ─────────────────────────────────────────────────────────────────────────────
const http = require("node:http");
const path = require("node:path");

const N = 20;                       // usuarios simultáneos
const fallos = [];
const check = (cond, msg) => { if (!cond) fallos.push(msg); };

(async () => {
    // ── la API falsa ─────────────────────────────────────────────────────────
    const vistas = [];              // claves que vio el servidor, en orden de llegada
    const pendientes = [];
    let sueltas = false;

    const stub = http.createServer((req, res) => {
        const clave = req.headers["x-api-key"] || "(sin clave)";
        vistas.push(clave);
        const responder = () => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ network: clave, chain_id: 202604, block: 1, episodic_memories: 0 }));
        };
        // La primera tanda se retiene entera y se contesta al revés: la primera en
        // llegar es la última en ser contestada. Así el entrelazado es real y no un
        // accidente. Lo que llegue después de esa tanda se contesta al toque.
        if (sueltas) return responder();
        pendientes.push(responder);
        if (pendientes.length === N) {
            sueltas = true;
            setImmediate(() => { while (pendientes.length) pendientes.pop()(); });
        }
    });
    await new Promise(r => stub.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${stub.address().port}`;

    // API_BASE se lee al cargar el módulo: hay que fijarlo antes del require.
    process.env.CHAINMEMORY_API_BASE = base;
    process.env.CHAINMEMORY_API_KEY = "clave-del-entorno";
    delete process.env.CHAINMEMORY_SEED_PHRASE;

    const mcp = require(process.env.CM_MCP || path.resolve(process.cwd(), "server.js"));
    const { requestContext, dispatchTool, buildServer, TOOLS } = mcp;

    // ── 1. N usuarios a la vez, cada uno con su clave ────────────────────────
    const llamada = (clave) => requestContext.run({ apiKey: clave }, () =>
        dispatchTool({ params: { name: "chainmemory_stats", arguments: {} } })
    );

    const claves = Array.from({ length: N }, (_, i) => `clave-usuario-${String(i).padStart(2, "0")}`);
    const res = await Promise.all(claves.map(llamada));

    for (let i = 0; i < N; i++) {
        const texto = res[i].content[0].text;
        check(texto.includes(claves[i]),
            `el usuario ${claves[i]} no recibió su propia clave de vuelta: ${texto.split("\n")[1]}`);
        const ajenas = claves.filter((c, j) => j !== i && texto.includes(c));
        check(ajenas.length === 0,
            `el usuario ${claves[i]} vio claves ajenas: ${ajenas.join(", ")}`);
    }
    check(new Set(vistas).size === N, `la API falsa vio ${new Set(vistas).size} claves distintas, esperaba ${N}`);
    check(!vistas.includes("clave-del-entorno"), "alguna request usó la clave del entorno teniendo contexto propio");
    console.log(`concurrencia : ${N} usuarios simultáneos, ${new Set(vistas).size} claves distintas, ` +
                `${fallos.length ? fallos.length + " problemas" : "ninguna cruzada"}`);

    // ── 2. sin contexto se cae al entorno (el caso stdio) ────────────────────
    const solo = await dispatchTool({ params: { name: "chainmemory_stats", arguments: {} } });
    check(solo.content[0].text.includes("clave-del-entorno"),
        "sin contexto no se usó CHAINMEMORY_API_KEY: stdio quedaría roto");
    console.log("stdio        : sin contexto cae a CHAINMEMORY_API_KEY, como antes");

    // ── 3. lo que no está en el subconjunto no se puede llamar ───────────────
    // Defensa en profundidad de la bóveda ciega: en el remoto no alcanza con no
    // publicar chainmemory_seal, tampoco tiene que poder invocarse por nombre.
    const SUBCONJUNTO = ["chainmemory_remember", "chainmemory_recall", "search_memories",
                         "list_memories_filtered", "get_memory", "get_project_state",
                         "list_projects", "chainmemory_stats"];
    const parcial = buildServer({ tools: TOOLS.filter(t => SUBCONJUNTO.includes(t.name)) });
    const handlers = parcial._requestHandlers;
    const llamar = handlers && handlers.get("tools/call");
    check(typeof llamar === "function", "no se pudo tomar el handler tools/call del Server");
    if (typeof llamar === "function") {
        for (const prohibida of ["chainmemory_seal", "chainmemory_open_sealed", "chainmemory_new_seed", "delete_project"]) {
            const r = await llamar({ method: "tools/call", params: { name: prohibida, arguments: {} } }, {});
            const texto = (r.content && r.content[0] && r.content[0].text) || "";
            check(r.isError === true && /Unknown tool/.test(texto),
                `${prohibida} NO fue rechazada por un servidor con subconjunto: ${texto.slice(0, 80)}`);
        }
        const listar = handlers.get("tools/list");
        const pub = await listar({ method: "tools/list", params: {} }, {});
        check(pub.tools.length === SUBCONJUNTO.length,
            `el servidor parcial publica ${pub.tools.length} herramientas, esperaba ${SUBCONJUNTO.length}`);
        console.log(`subconjunto  : ${pub.tools.length} herramientas publicadas; seal, open_sealed, new_seed y delete_project rechazadas por nombre`);
    }

    stub.close();

    if (fallos.length) {
        console.error("\nFALLA:");
        for (const f of fallos) console.error("  - " + f);
        process.exit(1);
    }
    console.log("\nOK: las claves no se cruzan, stdio sigue igual y el subconjunto se respeta.");
})().catch(e => { console.error("Fatal:", e); process.exit(1); });
