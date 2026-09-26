// ─────────────────────────────────────────────────────────────────────────────
// motor.mjs — el modelo all-MiniLM-L6-v2 completo, con codigo propio:
// tokenizador propio, lector ONNX propio y el nucleo WebAssembly generado por el
// ensamblador propio. Nada de terceros, ni al correr ni al construir.
//
// Da el mismo vector que el servidor (sentence-transformers): [CLS] + hasta 254
// tokens + [SEP], 6 capas BERT, promedio de los tokens y normalizacion L2.
//
// Calcula en float32 con los pesos del archivo (float16, convertidos exacto a
// float32). Las constantes van con su valor exacto, como en el servidor, no con
// el redondeo a 16 bits que trae el grafo ONNX (√32, √2 y epsilon de LayerNorm).
//
//   const motor = await crearMotor({ onnx: bytesDelModelo, tokenizer: tokenizerJsonParseado });
//   const vector = motor.embed("texto");     // Float32Array(384), norma 1
// ─────────────────────────────────────────────────────────────────────────────
import { leerOnnx, f16aF32 } from "./onnx.mjs";
import { crearTokenizador, MAX_TOKENS } from "./tokenizador.mjs";
import { moduloNucleo } from "./nucleo.mjs";

const H = 384, CABEZAS = 12, DH = 32, FF = 1536, CAPAS = 6;
const EPS = 1e-12;                        // layer_norm_eps de config.json
const ESCALA = 1 / Math.sqrt(DH);
const TM = 4, TN = 16;                    // bloque del nucleo (el mas rapido medido)
const FILAS = 16;                         // las filas se rellenan a multiplo de 16 (sirve para TM y TN)

// erf con error absoluto < 1.5e-7 (Abramowitz y Stegun 7.1.26), en float64.
function erf(x) {
    const s = x < 0 ? -1 : 1, a = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * a);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
    return s * y;
}

function pesosDelModelo(onnx) {
    const { nodos, pesos } = leerOnnx(onnx);
    const f32 = (nombre) => {
        const t = pesos.get(nombre);
        if (!t) throw new Error(`falta el peso ${nombre}`);
        return t.tipo === "float16" ? f16aF32(t.datos) : t.tipo === "float32" ? t.datos : (() => { throw new Error(`${nombre}: tipo ${t.tipo}`); })();
    };
    // Las matrices no tienen nombre propio en el archivo: se identifican por el
    // nodo MatMul que las usa (/encoder/layer.N/.../MatMul).
    const matriz = new Map();
    for (const n of nodos) {
        if (n.op !== "MatMul") continue;
        const w = n.entradas.find((e) => pesos.has(e));
        if (w) matriz.set(n.nombre, { datos: f32(w), dims: pesos.get(w).dims });
    }
    const mat = (capa, parte, [k, nn]) => {
        const m = matriz.get(`/encoder/layer.${capa}/${parte}/MatMul`);
        if (!m) throw new Error(`falta la matriz de ${parte} en la capa ${capa}`);
        if (m.dims[0] !== k || m.dims[1] !== nn) throw new Error(`${parte} capa ${capa}: ${m.dims} en vez de ${k},${nn}`);
        return m.datos;
    };
    // La tabla de palabras (30522×384) queda en float16, como viene en el
    // archivo: pasarla entera a float32 ocupaba 23 MB mas. Se convierte fila por
    // fila al usarla, con la misma conversion exacta.
    const tp = pesos.get("embeddings.word_embeddings.weight");
    if (!tp) throw new Error("falta el peso embeddings.word_embeddings.weight");
    const p = {
        palabras: tp.tipo === "float16" ? tp.datos : f32("embeddings.word_embeddings.weight"),
        posiciones: f32("embeddings.position_embeddings.weight"),
        tipos: f32("embeddings.token_type_embeddings.weight"),
        lnE: [f32("embeddings.LayerNorm.weight"), f32("embeddings.LayerNorm.bias")],
        capas: [],
    };
    for (let c = 0; c < CAPAS; c++) {
        const b = (s) => f32(`encoder.layer.${c}.${s}`);
        p.capas.push({
            q: mat(c, "attention/self/query", [H, H]), k: mat(c, "attention/self/key", [H, H]), v: mat(c, "attention/self/value", [H, H]),
            bq: b("attention.self.query.bias"), bk: b("attention.self.key.bias"), bv: b("attention.self.value.bias"),
            o: mat(c, "attention/output/dense", [H, H]), bo: b("attention.output.dense.bias"),
            ln1: [b("attention.output.LayerNorm.weight"), b("attention.output.LayerNorm.bias")],
            i: mat(c, "intermediate/dense", [H, FF]), bi: b("intermediate.dense.bias"),
            o2: mat(c, "output/dense", [FF, H]), bo2: b("output.dense.bias"),
            ln2: [b("output.LayerNorm.weight"), b("output.LayerNorm.bias")],
        });
    }
    return p;
}

/**
 * @param onnx       Uint8Array con model_fp16.onnx (ya verificado contra su hash)
 * @param tokenizer  tokenizer.json parseado (ya verificado contra su hash)
 */
export async function crearMotor({ onnx, tokenizer }) {
    const tok = crearTokenizador(tokenizer);
    const P = pesosDelModelo(onnx);

    // ── memoria del nucleo: pesos de las matrices y zonas de trabajo ────────
    let tope = 0;
    const reservar = (floats) => { const p = tope; tope += Math.ceil(floats * 4 / 16) * 16; return p; };
    const NMAX = MAX_TOKENS;                                     // 256, ya multiplo de 16
    const capas = P.capas.map(() => ({
        wqkv: reservar(H * 3 * H), bqkv: reservar(3 * H), wo: reservar(H * H), bo: reservar(H),
        wi: reservar(H * FF), bi: reservar(FF), wo2: reservar(FF * H), bo2: reservar(H),
    }));
    const Z = {
        x: reservar(NMAX * H), qkv: reservar(NMAX * 3 * H), q: reservar(NMAX * DH), kt: reservar(DH * NMAX), v: reservar(NMAX * DH),
        s: reservar(NMAX * NMAX), ctxh: reservar(NMAX * DH), ctx: reservar(NMAX * H), a: reservar(NMAX * H),
        h: reservar(NMAX * FF), o: reservar(NMAX * H), cero: reservar(FF),
    };
    const memoria = new WebAssembly.Memory({ initial: Math.ceil(tope / 65536) + 1 });
    const { bytes } = moduloNucleo({ TM, TN });
    const { instance } = await WebAssembly.instantiate(bytes, { env: { mem: memoria } });
    const matmul = instance.exports.matmul;
    const F = new Float32Array(memoria.buffer);
    const en = (ptr, n) => F.subarray(ptr / 4, ptr / 4 + n);

    // Q, K y V se calculan juntas: W = [Wq | Wk | Wv] (384×1152).
    P.capas.forEach((c, i) => {
        const d = capas[i], w = en(d.wqkv, H * 3 * H);
        for (let r = 0; r < H; r++) {
            w.set(c.q.subarray(r * H, r * H + H), r * 3 * H);
            w.set(c.k.subarray(r * H, r * H + H), r * 3 * H + H);
            w.set(c.v.subarray(r * H, r * H + H), r * 3 * H + 2 * H);
        }
        en(d.bqkv, 3 * H).set(c.bq, 0); en(d.bqkv, 3 * H).set(c.bk, H); en(d.bqkv, 3 * H).set(c.bv, 2 * H);
        en(d.wo, H * H).set(c.o); en(d.bo, H).set(c.bo);
        en(d.wi, H * FF).set(c.i); en(d.bi, FF).set(c.bi);
        en(d.wo2, FF * H).set(c.o2); en(d.bo2, H).set(c.bo2);
        // Ya estan en la memoria del nucleo: la copia en JavaScript sobraba (42 MB).
        c.q = c.k = c.v = c.o = c.i = c.o2 = null;
    });
    // float16 -> float32 por tabla (65536 valores, exacto): para la fila de cada token.
    const F16 = P.palabras instanceof Uint16Array ? f16aF32(Uint16Array.from({ length: 65536 }, (_, i) => i)) : null;
    en(Z.cero, FF).fill(0);

    // LayerNorm sobre filas de 384, en el lugar; sumando antes "residuo" si viene.
    function layerNorm(ptr, filas, [g, b], residuo) {
        const x = en(ptr, filas * H), r = residuo === undefined ? null : en(residuo, filas * H);
        for (let f = 0; f < filas; f++) {
            const o = f * H;
            let m = 0;
            if (r) for (let j = 0; j < H; j++) x[o + j] += r[o + j];
            for (let j = 0; j < H; j++) m += x[o + j];
            m /= H;
            let v = 0;
            for (let j = 0; j < H; j++) { const d = x[o + j] - m; v += d * d; }
            const inv = 1 / Math.sqrt(v / H + EPS);
            for (let j = 0; j < H; j++) x[o + j] = (x[o + j] - m) * inv * g[j] + b[j];
        }
    }

    function embed(texto) {
        const ids = tok.paraModelo(texto);
        const n = ids.length;
        const N = Math.ceil(n / FILAS) * FILAS;                 // filas rellenadas

        // Embeddings: palabra + posicion + tipo 0, y LayerNorm.
        const x = en(Z.x, N * H);
        x.fill(0);
        for (let t = 0; t < n; t++) {
            const pw = ids[t] * H, pp = t * H, o = t * H;
            if (F16) for (let j = 0; j < H; j++) x[o + j] = F16[P.palabras[pw + j]] + P.posiciones[pp + j] + P.tipos[j];
            else     for (let j = 0; j < H; j++) x[o + j] = P.palabras[pw + j] + P.posiciones[pp + j] + P.tipos[j];
        }
        layerNorm(Z.x, N, P.lnE);

        const qkv = en(Z.qkv, N * 3 * H), q = en(Z.q, N * DH), kt = en(Z.kt, DH * N), v = en(Z.v, N * DH);
        const s = en(Z.s, N * N), ctxh = en(Z.ctxh, N * DH), ctx = en(Z.ctx, N * H), hh = en(Z.h, N * FF);

        for (let c = 0; c < CAPAS; c++) {
            const d = capas[c];
            matmul(Z.x, d.wqkv, Z.qkv, d.bqkv, N, 3 * H, H);

            for (let cab = 0; cab < CABEZAS; cab++) {
                const oq = cab * DH, ok = H + cab * DH, ov = 2 * H + cab * DH;
                for (let t = 0; t < N; t++) {
                    const fila = t * 3 * H;
                    for (let j = 0; j < DH; j++) {
                        q[t * DH + j] = qkv[fila + oq + j];
                        kt[j * N + t] = qkv[fila + ok + j];
                        v[t * DH + j] = qkv[fila + ov + j];
                    }
                }
                matmul(Z.q, Z.kt, Z.s, Z.cero, N, N, DH);        // Q·Kᵀ
                // softmax por fila, con la escala 1/√32; las columnas de relleno
                // (t >= n) no participan.
                for (let i = 0; i < N; i++) {
                    const o = i * N;
                    let max = -Infinity;
                    for (let j = 0; j < n; j++) { const z = s[o + j] * ESCALA; s[o + j] = z; if (z > max) max = z; }
                    let suma = 0;
                    for (let j = 0; j < n; j++) { const e = Math.exp(s[o + j] - max); s[o + j] = e; suma += e; }
                    const inv = 1 / suma;
                    for (let j = 0; j < n; j++) s[o + j] *= inv;
                    for (let j = n; j < N; j++) s[o + j] = 0;
                }
                matmul(Z.s, Z.v, Z.ctxh, Z.cero, N, DH, N);      // P·V
                for (let t = 0; t < N; t++) ctx.set(ctxh.subarray(t * DH, t * DH + DH), t * H + cab * DH);
            }

            matmul(Z.ctx, d.wo, Z.a, d.bo, N, H, H);
            layerNorm(Z.a, N, P.capas[c].ln1, Z.x);              // a = LN(a + x)

            matmul(Z.a, d.wi, Z.h, d.bi, N, FF, H);
            for (let j = 0; j < N * FF; j++) { const z = hh[j]; hh[j] = 0.5 * z * (1 + erf(z * Math.SQRT1_2)); }
            matmul(Z.h, d.wo2, Z.x, d.bo2, N, H, FF);
            layerNorm(Z.x, N, P.capas[c].ln2, Z.a);              // x = LN(x + a)
        }

        // Promedio de los n tokens reales y normalizacion L2.
        const out = new Float64Array(H);
        for (let t = 0; t < n; t++) for (let j = 0; j < H; j++) out[j] += x[t * H + j];
        let norma = 0;
        for (let j = 0; j < H; j++) { out[j] /= n; norma += out[j] * out[j]; }
        norma = Math.sqrt(norma) || 1;
        const vector = new Float32Array(H);
        for (let j = 0; j < H; j++) vector[j] = out[j] / norma;
        return vector;
    }

    return { embed, tokens: (t) => tok.paraModelo(t), memoriaBytes: memoria.buffer.byteLength };
}
