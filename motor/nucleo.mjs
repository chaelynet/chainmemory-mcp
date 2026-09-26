// ─────────────────────────────────────────────────────────────────────────────
// nucleo.mjs — genera el nucleo de calculo del motor: C = A·B + bias, en
// WebAssembly SIMD, con el ensamblador propio.
//
//   A: M×K, B: K×N, C: M×N, bias: N    (float32, por filas, punteros en bytes)
//
// Es lo que hace casi todo el trabajo del modelo (mas del 90 % de las
// operaciones). El resto (atencion, layernorm, GELU, promedio) es poco y va en
// JavaScript.
//
// Se calcula por bloques de TM filas × TN columnas que viven en registros: por
// cada k se leen TN/4 vectores de B una sola vez y se usan para las TM filas.
// Requisitos (los cumple quien llama rellenando con ceros): M multiplo de TM,
// N multiplo de TN, K >= 1.
// ─────────────────────────────────────────────────────────────────────────────
import * as W from "./ensamblador.mjs";

export function generarMatmul({ TM = 4, TN = 8 } = {}) {
    if (TN % 4) throw new Error("TN tiene que ser multiplo de 4");
    const V = TN / 4;

    // Indices de locales: primero los parametros, despues los declarados.
    const [a, b, c, bias, M, N, K] = [0, 1, 2, 3, 4, 5, 6];
    let n = 7;
    const i = n++, j = n++, k = n++, pb = n++, sb = n++, tp = n++;
    const pa = Array.from({ length: TM }, () => n++);
    const nI32 = n - 7;
    const acc = Array.from({ length: TM }, () => Array.from({ length: V }, () => n++));
    const bv = Array.from({ length: V }, () => n++);
    const av = n++;
    const nV128 = n - 7 - nI32;

    const todos = (f) => acc.flatMap((fila, r) => fila.map((x, v) => f(x, r, v)));

    const cuerpo = [
        W.get(N), W.i32(4), W.i32_mul(), W.set(sb),
        W.i32(0), W.set(i),
        W.loop(
            W.i32(0), W.set(j),
            W.loop(
                // acumuladores = bias[j .. j+TN]
                W.get(bias), W.get(j), W.i32(4), W.i32_mul(), W.i32_add(), W.set(tp),
                todos((x, r, v) => [W.get(tp), W.v128_load(v * 16), W.set(x)]),
                // pa[r] = a + (i + r)·K·4 ;  pb = b + j·4
                pa.map((p, r) => [W.get(a), W.get(i), W.i32(r), W.i32_add(), W.get(K), W.i32_mul(),
                                  W.i32(4), W.i32_mul(), W.i32_add(), W.set(p)]),
                W.get(b), W.get(j), W.i32(4), W.i32_mul(), W.i32_add(), W.set(pb),
                W.get(K), W.set(k),
                W.loop(
                    bv.map((x, v) => [W.get(pb), W.v128_load(v * 16), W.set(x)]),
                    pa.map((p, r) => [
                        W.get(p), W.v128_load32_splat(0), W.set(av),
                        acc[r].map((x, v) => [W.get(x), W.get(av), W.get(bv[v]), W.f32x4_mul(), W.f32x4_add(), W.set(x)]),
                        W.get(p), W.i32(4), W.i32_add(), W.set(p),
                    ]),
                    W.get(pb), W.get(sb), W.i32_add(), W.set(pb),
                    W.get(k), W.i32(1), W.i32_sub(), W.tee(k), W.br_if(0),
                ),
                // C[i+r, j ..] = acumuladores
                acc.map((fila, r) => [
                    W.get(c), W.get(i), W.i32(r), W.i32_add(), W.get(N), W.i32_mul(), W.get(j), W.i32_add(),
                    W.i32(4), W.i32_mul(), W.i32_add(), W.set(tp),
                    fila.map((x, v) => [W.get(tp), W.get(x), W.v128_store(v * 16)]),
                ]),
                W.get(j), W.i32(TN), W.i32_add(), W.tee(j), W.get(N), W.i32_lt_s(), W.br_if(0),
            ),
            W.get(i), W.i32(TM), W.i32_add(), W.tee(i), W.get(M), W.i32_lt_s(), W.br_if(0),
        ),
    ];

    return {
        nombre: "matmul",
        params: [W.T.i32, W.T.i32, W.T.i32, W.T.i32, W.T.i32, W.T.i32, W.T.i32],
        locales: [[nI32, W.T.i32], [nV128, W.T.v128]],
        cuerpo,
        TM, TN,
    };
}

export function moduloNucleo(opciones) {
    const f = generarMatmul(opciones);
    return { bytes: W.modulo({ memoria: { modulo: "env", campo: "mem", paginasMin: 1 }, funciones: [f] }), TM: f.TM, TN: f.TN };
}
