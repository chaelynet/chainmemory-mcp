/**
 * cm-embed.js — vector de busqueda calculado en la maquina del usuario.
 *
 * Una memoria sellada la puede guardar el servidor pero no leerla, asi que
 * tampoco puede calcular el vector con el que se la encuentra. Lo calcula este
 * modulo, con el mismo modelo que usa el servidor (all-MiniLM-L6-v2) y el mismo
 * corte en 256 tokens, para que el vector sea el que el servidor habria
 * calculado. Validado contra las 791 memorias reales: coseno 1.000000 en fp32 y
 * 0.999998 en el peor caso con fp16.
 *
 * DOS DETALLES QUE NO SE PUEDEN CAMBIAR sin romper la compatibilidad con los
 * vectores que ya estan guardados:
 *
 *   1. El corte es [CLS] + 254 tokens + [SEP], armado a mano. El truncado
 *      automatico de transformers.js se come el [SEP] final y para textos
 *      largos —el 68% de las memorias reales pasa los 256 tokens— el vector
 *      sale distinto: medido, coseno 0.9756 en vez de 1.000000.
 *   2. Mean pooling sobre todos los tokens y normalizacion L2.
 *
 * transformers.js NO es dependencia del paquete: en Node arrastra
 * onnxruntime-node, onnxruntime-web y sharp, unos 622 MB. El MCP pesa 130 KB y
 * se instala con npx. Asi que se carga si esta, y si no esta la memoria se
 * guarda igual: sellada, sin vector, y se le dice al usuario.
 *
 * La misma logica corre en la extension (cm-embed.js de chainmemory-extension).
 * Las dos copias se validan contra los mismos vectores de referencia del
 * servidor, asi que si alguna se desvia, su prueba falla.
 */
'use strict';

const MODELO = 'Xenova/all-MiniLM-L6-v2';
const MAX_TOKENS = 256;
const DIM = 384;

let _cargando = null;
let _noDisponible = null;

/**
 * Devuelve { embed(texto) } o null si transformers.js no esta instalado.
 * El motivo queda en motivoNoDisponible().
 */
async function crearEmbedder({ dtype = 'fp16' } = {}) {
    if (_noDisponible) return null;
    if (!_cargando) _cargando = cargar(dtype).catch((e) => {
        _cargando = null;
        _noDisponible = e.message;
        return null;
    });
    return _cargando;
}

function motivoNoDisponible() {
    return _noDisponible;
}

async function cargar(dtype) {
    let T;
    try {
        T = await import('@huggingface/transformers');
    } catch (e) {
        throw new Error(
            '@huggingface/transformers is not installed. Sealed memories are saved encrypted ' +
            'but cannot be found by search until you install it: npm i -g @huggingface/transformers ' +
            '(it is a large download, about 600 MB, which is why it is not bundled).'
        );
    }
    const tokenizador = await T.AutoTokenizer.from_pretrained(MODELO);
    const modelo = await T.AutoModel.from_pretrained(MODELO, { dtype });

    // Los ids de [CLS] y [SEP] salen de tokenizar un texto vacio.
    const vacio = Array.from((await tokenizador('')).input_ids.data).map(Number);
    const CLS = vacio[0];
    const SEP = vacio[vacio.length - 1];

    async function embed(texto) {
        const contenido = Array.from(
            (await tokenizador(String(texto ?? ''), { add_special_tokens: false })).input_ids.data
        ).map(Number);
        const ids = [CLS, ...contenido.slice(0, MAX_TOKENS - 2), SEP];
        const n = ids.length;
        const entrada = {
            input_ids:      new T.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, n]),
            attention_mask: new T.Tensor('int64', BigInt64Array.from(ids.map(() => 1n)), [1, n]),
            token_type_ids: new T.Tensor('int64', BigInt64Array.from(ids.map(() => 0n)), [1, n]),
        };
        const salida = await modelo(entrada);
        return promediarYNormalizar(salida.last_hidden_state, n);
    }
    return { embed, dtype };
}

function promediarYNormalizar(estado, n) {
    const dim = estado.dims[2];
    const d = estado.data;
    const v = new Float64Array(dim);
    for (let t = 0; t < n; t++) {
        const base = t * dim;
        for (let k = 0; k < dim; k++) v[k] += Number(d[base + k]);
    }
    let norma = 0;
    for (let k = 0; k < dim; k++) { v[k] /= n; norma += v[k] * v[k]; }
    norma = Math.sqrt(norma) || 1;
    const out = new Array(dim);
    for (let k = 0; k < dim; k++) out[k] = v[k] / norma;
    return out;
}

module.exports = { MODELO, MAX_TOKENS, DIM, crearEmbedder, motivoNoDisponible };
