#!/usr/bin/env node
// ============================================================
// ChainMemory MCP — endpoint remoto (Streamable HTTP)
// ============================================================
//
// El mismo servidor MCP de siempre, pero accesible por HTTPS en vez de por
// stdio. El que quiera probar ChainMemory pega una URL en su cliente y listo:
// no hace falta Node, ni npm, ni editar un JSON de configuración.
//
// Tres cosas que este archivo hace a propósito, y por qué:
//
// 1. LA BÓVEDA CIEGA NO VIAJA. chainmemory_seal, chainmemory_open_sealed y
//    chainmemory_new_seed cifran con una frase de 12 palabras que nunca sale de
//    la máquina del usuario. Si corrieran acá, la frase tendría que llegar hasta
//    este servidor, y la promesa —el servidor guarda un blob que no puede leer—
//    dejaría de ser cierta. Así que no están. El arranque se cae si alguien las
//    mete en la lista por descuido.
//
// 2. UN SERVIDOR Y UN TRANSPORTE POR REQUEST (modo sin sesión). No es sólo
//    prolijidad: es lo que garantiza que la clave de un usuario no pueda
//    alcanzar la request de otro. Todo se crea adentro del contexto de la
//    request y muere con ella.
//
// 3. ORIGIN Y HOST SE VALIDAN. Sin eso, cualquier web abierta en el navegador
//    del usuario podría hablarle a este endpoint (DNS rebinding). La
//    especificación lo marca como MUST y responde 403.
//
// Variables de entorno:
//   CM_MCP_PORT              puerto (default 3005)
//   CM_MCP_HOST              interfaz (default 127.0.0.1; nginx hace de frente)
//   CM_MCP_ALLOWED_HOSTS     hosts válidos en el header Host, separados por coma
//   CM_MCP_ALLOWED_ORIGINS   origins válidos, separados por coma
//   CHAINMEMORY_API_BASE     API detrás (default https://api.chainmemory.ai)
//
// La clave NO se configura acá: la trae cada cliente en X-API-Key.
// ============================================================

const http = require("node:http");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { TOOLS, buildServer, requestContext, API_BASE } = require("./server.js");

const PORT = parseInt(process.env.CM_MCP_PORT || "3005", 10);
const HOST = process.env.CM_MCP_HOST || "127.0.0.1";
const RUTA = "/mcp";
const MAX_BODY = 1024 * 1024;   // 1 MB. Una memoria son ~20 KB; esto es el techo del transporte.

function lista(valor, porDefecto) {
    const partes = String(valor || "").split(",").map(s => s.trim()).filter(Boolean);
    return partes.length ? partes : porDefecto;
}
const ALLOWED_HOSTS   = lista(process.env.CM_MCP_ALLOWED_HOSTS,   ["mcp.chainmemory.ai", `${HOST}:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = lista(process.env.CM_MCP_ALLOWED_ORIGINS, ["https://mcp.chainmemory.ai"]);

// ------------------------------------------------------------
// Qué se publica
// ------------------------------------------------------------
// Fase 1: lo mínimo para que alguien pruebe ChainMemory de verdad —escribir,
// buscar, listar, leer una memoria, ver el estado del Brain y los proyectos—
// y nada más. Menos superficie, y si esto no convence, más herramientas tampoco
// iban a convencer. Se amplía cuando el endpoint esté parado y midiendo.
const HERRAMIENTAS_REMOTAS = [
    "chainmemory_remember",
    "chainmemory_recall",
    "search_memories",
    "list_memories_filtered",
    "get_memory",
    "get_project_state",
    "get_project_brief",
    "list_projects",
    "chainmemory_stats"
];

// Las tres que no pueden existir acá, pase lo que pase.
const BOVEDA = ["chainmemory_seal", "chainmemory_open_sealed", "chainmemory_new_seed"];

// Las descripciones están escritas para el MCP local, que sí tiene bóveda. Acá
// hay que corregirlas: si le decimos al modelo que puede pasar sealed:true, lo
// va a intentar y se va a comer un error que no explica nada. Una herramienta
// que promete lo que no puede cumplir es peor que una que no existe.
const SELLADO_LOCAL =
    " Sealing is not available on this remote endpoint: it would require sending " +
    "the 12-word phrase to the server, which is exactly what the blind vault exists " +
    "to avoid. Install the local MCP (npx chainmemory-mcp) if you need it.";

function adaptarParaRemoto(t) {
    // search_memories: lo de la boveda (consulta como vector, selladas abiertas
    // aca) no aplica en el servidor, donde no hay frase.
    if (t.name === "search_memories") {
        const copia = JSON.parse(JSON.stringify(t));
        copia.description = copia.description.replace(/ With the blind vault configured[^]*?\.(?=["\s]|$)/, "");
        return copia;
    }
    // get_project_brief: el remoto no guarda que version leyo cada uno; sin since
    // compara con la version anterior, y la descripcion tiene que decir eso.
    if (t.name === "get_project_brief") {
        const copia = JSON.parse(JSON.stringify(t));
        copia.description = copia.description.replace(/ This local server remembers[^]*$/,
            " On this remote endpoint nothing is remembered between calls: WHAT CHANGED compares with the previous version unless you pass since.");
        copia.inputSchema.properties.since.description = "Version to compare against for the WHAT CHANGED section. Default: the previous version.";
        return copia;
    }
    if (t.name !== "chainmemory_remember") return t;
    const copia = JSON.parse(JSON.stringify(t));
    copia.description = copia.description
        // Toda la oracion que ofrece sealed:true, termine como termine: si la
        // descripcion del MCP local cambia, el remoto igual no la ofrece.
        .replace(/Pass sealed:true[^]*?\.\s(?=[A-Z])/, "")
        .replace(" Sealed memories carry their hash from the client and are citable immediately.", SELLADO_LOCAL);
    if (copia.inputSchema && copia.inputSchema.properties) delete copia.inputSchema.properties.sealed;
    return copia;
}

const HERRAMIENTAS = TOOLS.filter(t => HERRAMIENTAS_REMOTAS.includes(t.name)).map(adaptarParaRemoto);

// Invariantes de arranque. Prefiere no levantar a levantar mal.
(function verificar() {
    const filtradas = HERRAMIENTAS.map(t => t.name);
    const faltan = HERRAMIENTAS_REMOTAS.filter(n => !filtradas.includes(n));
    if (faltan.length) {
        console.error(`No existen estas herramientas en el MCP: ${faltan.join(", ")}`);
        process.exit(1);
    }
    const coladas = filtradas.filter(n => BOVEDA.includes(n));
    if (coladas.length) {
        console.error(`ABORTA: ${coladas.join(", ")} usa la frase de 12 palabras y no puede correr en el servidor.`);
        process.exit(1);
    }
})();

// ------------------------------------------------------------
// Respuestas de error en JSON-RPC
// ------------------------------------------------------------
// El cliente habla JSON-RPC: un error suyo en HTML o texto pelado lo deja sin
// saber qué pasó. Los errores del transporte los arma el SDK; estos son los
// nuestros, los de antes de entregarle la request.
function errorJsonRpc(res, status, code, message, extra = {}) {
    const cuerpo = JSON.stringify({ jsonrpc: "2.0", error: { code, message, ...extra }, id: null });
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(cuerpo) });
    res.end(cuerpo);
}

function leerCuerpo(req) {
    return new Promise((resolve, reject) => {
        let total = 0;
        const partes = [];
        let cortado = false;
        req.on("data", (c) => {
            if (cortado) return;                 // se sigue drenando, pero ya no se guarda
            total += c.length;
            if (total > MAX_BODY) {
                cortado = true;
                partes.length = 0;
                // No se destruye el socket acá: si se corta antes de contestar, el
                // cliente ve "socket hang up" y nunca se entera de por qué. Se rechaza,
                // se responde 413 y recién ahí se cierra.
                const e = new Error(`el cuerpo supera ${MAX_BODY} bytes`);
                e.demasiado = true;
                return reject(e);
            }
            partes.push(c);
        });
        req.on("end", () => {
            const texto = Buffer.concat(partes).toString("utf8");
            if (!texto.trim()) return resolve(undefined);
            try { resolve(JSON.parse(texto)); }
            catch (e) { const err = new Error("JSON inválido"); err.jsonMalo = true; reject(err); }
        });
        req.on("error", reject);
    });
}

// ------------------------------------------------------------
// El servidor
// ------------------------------------------------------------

const app = http.createServer(async (req, res) => {
    const ruta = (req.url || "").split("?")[0];

    // Salud: sin clave, sin datos de nadie. Sólo para monitoreo.
    if (ruta === "/health" && req.method === "GET") {
        const cuerpo = JSON.stringify({
            status: "ok",
            server: "chainmemory-mcp",
            version: require("./package.json").version,
            transport: "streamable-http",
            endpoint: RUTA,
            tools: HERRAMIENTAS.length,
            api_base: API_BASE
        });
        res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(cuerpo) });
        return res.end(cuerpo);
    }

    if (ruta !== RUTA) {
        return errorJsonRpc(res, 404, -32601, `No existe ${ruta}. El endpoint MCP es ${RUTA}.`);
    }

    // La clave es de la request, nunca del proceso. Sin ella no se hace nada.
    const apiKey = req.headers["x-api-key"];
    if (req.method === "POST" && (typeof apiKey !== "string" || !apiKey.trim())) {
        return errorJsonRpc(res, 401, -32001,
            "Falta el header X-API-Key. Conseguí una clave en https://faucet.chainmemory.ai");
    }

    let cuerpo;
    if (req.method === "POST") {
        try {
            cuerpo = await leerCuerpo(req);
        } catch (e) {
            if (e.demasiado) {
                // Se contesta, se drena lo que quede para que el 413 llegue entero y
                // después se cierra la conexión.
                const cuerpo413 = JSON.stringify({ jsonrpc: "2.0", id: null,
                    error: { code: -32001, message: `Request demasiado grande (máximo ${MAX_BODY} bytes).` } });
                res.writeHead(413, {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(cuerpo413),
                    "Connection": "close"
                });
                res.end(cuerpo413, () => req.destroy());
                req.resume();
                return;
            }
            if (e.jsonMalo) return errorJsonRpc(res, 400, -32700, "Parse error: el cuerpo no es JSON válido.");
            return errorJsonRpc(res, 400, -32001, "No se pudo leer el cuerpo de la request.");
        }
    }

    // Todo lo que sigue vive adentro del contexto de ESTA request: el Server, el
    // transporte y las llamadas a la API. Nada sobrevive a la respuesta, que es
    // justamente lo que impide que dos usuarios concurrentes se crucen.
    await requestContext.run({ apiKey }, async () => {
        const sv = buildServer({ tools: HERRAMIENTAS });
        const transporte = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,          // sin sesión: cada request es independiente
            enableDnsRebindingProtection: true,
            allowedHosts: ALLOWED_HOSTS,
            allowedOrigins: ALLOWED_ORIGINS
        });
        res.on("close", () => {
            // Cerrar el stream es, además, la señal de cancelación de la spec.
            transporte.close().catch(() => {});
            sv.close().catch(() => {});
        });
        try {
            await sv.connect(transporte);
            await transporte.handleRequest(req, res, cuerpo);
        } catch (e) {
            console.error("[mcp-http] error atendiendo la request:", e && e.message);
            if (!res.headersSent) errorJsonRpc(res, 500, -32603, "Internal error");
        }
    });
});

app.on("clientError", (e, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

// Sólo escucha si se ejecuta directo; requerido como módulo no abre ningún puerto.
if (require.main === module) arrancar();

function arrancar() {
app.listen(PORT, HOST, () => {
    console.log(`[chainmemory-mcp-http v${require("./package.json").version}] escuchando en http://${HOST}:${PORT}${RUTA}`);
    console.log(`  herramientas : ${HERRAMIENTAS.length} (bóveda ciega excluida: ${BOVEDA.join(", ")})`);
    console.log(`  API          : ${API_BASE}`);
    console.log(`  hosts        : ${ALLOWED_HOSTS.join(", ")}`);
    console.log(`  origins      : ${ALLOWED_ORIGINS.join(", ")}`);
    console.log(`  clave        : la trae cada cliente en X-API-Key`);
});

for (const s of ["SIGINT", "SIGTERM"]) {
    process.on(s, () => { app.close(() => process.exit(0)); });
}
}

module.exports = { app, arrancar, HERRAMIENTAS, HERRAMIENTAS_REMOTAS, BOVEDA };
