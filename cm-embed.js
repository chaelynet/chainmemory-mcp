// ─────────────────────────────────────────────────────────────────────────────
// cm-embed.js — el vector de busqueda de una memoria, calculado en esta maquina
// con el motor propio de ChainMemory (motor/): tokenizador, lector del modelo y
// nucleo WebAssembly escritos por ChainMemory. Sin dependencias: ni npm ni nada
// bajado de un CDN.
//
// Para que: una memoria sellada es una que el servidor guarda pero no puede leer,
// asi que tampoco puede calcular el vector con el que se la encuentra. Lo calcula
// este proceso y lo manda junto con el blob. Lo mismo con la consulta: se manda
// el vector, no el texto, y el texto de lo que buscas no sale de tu maquina.
//
// Da el mismo vector que el servidor: validado contra el vector guardado de 837
// memorias reales (peor coseno 0.9999988) y token por token contra el
// tokenizador del servidor.
//
// Los pesos del modelo (45 MB) se bajan UNA vez de models.chainmemory.ai, se
// verifican contra su hash (anclado en la cadena) y se guardan en
// ~/.chainmemory/models/Xenova/all-MiniLM-L6-v2/v1/. Se vuelven a verificar cada
// vez que se cargan: si alguien los cambio, se descartan y se bajan de nuevo.
//
//   CHAINMEMORY_MODELS_DIR  — otra carpeta para el modelo (opcional)
// ─────────────────────────────────────────────────────────────────────────────
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");

const MODELOS_BASE = "https://models.chainmemory.ai/";
const RUTA_MODELO = "Xenova/all-MiniLM-L6-v2/v1/";

// SHA-256 de los archivos, copiados de SHA256SUMS. Estan anclados en la cadena
// de ChainMemory (202604), contrato ProjectStateAnchor
// 0xa7A8BA51950255b3e223a6745597C67009Fe7875, anchorId 103:
//   projectId = keccak256("cm:model:Xenova/all-MiniLM-L6-v2"), version 1
//   stateHash = SHA-256 de SHA256SUMS = SHA256SUMS_ANCLADO
const SHA256SUMS_ANCLADO = "4751c8bfd75b05bea5a057f817c779f7f922f4002edc03e2d9cb79285aa09f28";
const HASHES_MODELO = Object.freeze({
    "tokenizer.json":       "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0",
    "onnx/model_fp16.onnx": "2cdb5e58291813b6d6e248ed69010100246821a367fa17b1b81ae9483744533d",
});

// La descarga se corta solo si se queda QUIETA este tiempo (sin recibir ningun
// dato), no por su duracion total. Con un limite total de 2 minutos, una conexion
// lenta pero viva cortaba el modelo a medias (medido el 28/9: 46-930 KB/s hacia
// el servidor en Finlandia) y la primera memoria sellada quedaba sin vector.
const SIN_DATOS_MS = 60000;

function carpetaModelo() {
    const base = process.env.CHAINMEMORY_MODELS_DIR || path.join(os.homedir(), ".chainmemory", "models");
    return path.join(base, ...RUTA_MODELO.split("/").filter(Boolean));
}

const sha256 = (datos) => crypto.createHash("sha256").update(datos).digest("hex");

// Un archivo del modelo, verificado. Si esta en disco y coincide con su hash, se
// usa; si no esta o no coincide, se baja, se verifica y recien ahi se escribe
// (a un temporal y despues renombrado, para no dejar nunca un archivo a medias).
async function archivoVerificado(nombre) {
    const esperado = HASHES_MODELO[nombre];
    const destino = path.join(carpetaModelo(), ...nombre.split("/"));
    try {
        const local = fs.readFileSync(destino);
        if (sha256(local) === esperado) return local;
    } catch (_) { /* no esta: se baja */ }

    const datos = await bajar(MODELOS_BASE + RUTA_MODELO + nombre);
    const obtenido = sha256(datos);
    if (obtenido !== esperado) {
        throw new Error(`${nombre} no coincide con el hash anclado en la cadena (llego ${obtenido.slice(0, 16)}…); no se usa`);
    }
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    const temporal = `${destino}.${process.pid}.tmp`;
    fs.writeFileSync(temporal, datos);
    fs.renameSync(temporal, destino);
    return datos;
}

// Baja una URL entera. Se corta solo si pasan `sinDatosMs` sin recibir ningun
// dato (tambien mientras espera la conexion y la primera respuesta).
async function bajar(url, { sinDatosMs = SIN_DATOS_MS } = {}) {
    const control = new AbortController();
    let quieto = false;
    let reloj = null;
    const vigilar = () => {
        clearTimeout(reloj);
        reloj = setTimeout(() => { quieto = true; control.abort(); }, sinDatosMs);
    };
    vigilar();
    try {
        const r = await fetch(url, { signal: control.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status} al bajar ${url}`);
        const partes = [];
        const lector = r.body.getReader();
        for (;;) {
            vigilar();
            const { done, value } = await lector.read();
            if (done) break;
            partes.push(Buffer.from(value));
        }
        return Buffer.concat(partes);
    } catch (e) {
        if (quieto) throw new Error(`la descarga de ${url} se quedo ${Math.round(sinDatosMs / 1000)} s sin recibir datos`);
        throw e;
    } finally {
        clearTimeout(reloj);
    }
}

let _embedder = null;          // promesa: se crea una sola vez por proceso
let _motivo = null;            // por que no hay vector, si fallo

// Devuelve { embed(texto) -> Array de 384 } o null si no se pudo preparar
// (sin red la primera vez, archivo alterado...). Nunca lanza: quien llama decide
// que hacer sin vector, y motivoNoDisponible() dice por que.
function crearEmbedder() {
    if (!_embedder) {
        _embedder = (async () => {
            const [tokenizer, onnx] = await Promise.all([
                archivoVerificado("tokenizer.json"),
                archivoVerificado("onnx/model_fp16.onnx"),
            ]);
            const { crearMotor } = await import(pathToFileURL(path.join(__dirname, "motor", "motor.mjs")).href);
            const motor = await crearMotor({
                onnx: new Uint8Array(onnx.buffer, onnx.byteOffset, onnx.byteLength),
                tokenizer: JSON.parse(tokenizer.toString("utf8")),
            });
            _motivo = null;
            return { embed: async (texto) => Array.from(motor.embed(String(texto ?? ""))) };
        })().catch((e) => {
            _motivo = `The search model could not be prepared: ${e.message}`;
            _embedder = null;       // el proximo intento vuelve a probar
            return null;
        });
    }
    return _embedder;
}

function motivoNoDisponible() { return _motivo; }

module.exports = { crearEmbedder, motivoNoDisponible, carpetaModelo, bajar, SIN_DATOS_MS, HASHES_MODELO, SHA256SUMS_ANCLADO, MODELOS_BASE, RUTA_MODELO };
