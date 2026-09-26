// ─────────────────────────────────────────────────────────────────────────────
// ensamblador.mjs — arma un modulo WebAssembly byte por byte, sin herramientas
// de terceros.
//
// Cubre solo lo que usa el motor de ChainMemory: una memoria importada, funciones
// con parametros i32, locales i32/f32/v128, bucles, aritmetica entera, flotantes
// y las instrucciones SIMD de 128 bits. Cada instruccion es una funcion que
// devuelve sus bytes; un cuerpo es una lista (anidada) de esas listas.
//
// Referencia: WebAssembly Core Specification 2.0, capitulo 5 (formato binario)
// y la extension SIMD de 128 bits (opcodes con prefijo 0xFD).
// ─────────────────────────────────────────────────────────────────────────────

export const T = Object.freeze({ i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c, v128: 0x7b });

// ── codificacion de enteros (LEB128) ───────────────────────────────────────
export function uleb(n) {
    if (!Number.isInteger(n) || n < 0) throw new Error(`uleb: ${n}`);
    const out = [];
    do {
        let b = n & 0x7f;
        n = Math.floor(n / 128);
        if (n !== 0) b |= 0x80;
        out.push(b);
    } while (n !== 0);
    return out;
}

export function sleb(n) {
    if (!Number.isInteger(n)) throw new Error(`sleb: ${n}`);
    const out = [];
    for (;;) {
        const b = n & 0x7f;
        n >>= 7;                                  // aritmetico: conserva el signo
        const fin = (n === 0 && (b & 0x40) === 0) || (n === -1 && (b & 0x40) !== 0);
        out.push(fin ? b : b | 0x80);
        if (fin) return out;
    }
}

const nombre = (s) => { const b = [...new TextEncoder().encode(s)]; return [...uleb(b.length), ...b]; };
const vec = (items) => [...uleb(items.length), ...items.flat(Infinity)];
const seccion = (id, cuerpo) => { const b = cuerpo.flat(Infinity); return [id, ...uleb(b.length), ...b]; };
const f32bytes = (x) => [...new Uint8Array(new Float32Array([x]).buffer)];
const memarg = (align, offset) => [...uleb(align), ...uleb(offset)];
const simd = (op) => [0xfd, ...uleb(op)];

// ── instrucciones ───────────────────────────────────────────────────────────
// Control. Los bloques no devuelven valor (tipo 0x40).
export const block = (...cuerpo) => [0x02, 0x40, cuerpo, 0x0b];
export const loop  = (...cuerpo) => [0x03, 0x40, cuerpo, 0x0b];
export const br    = (n) => [0x0c, ...uleb(n)];
export const br_if = (n) => [0x0d, ...uleb(n)];
export const ret   = () => [0x0f];

// Locales
export const get = (i) => [0x20, ...uleb(i)];
export const set = (i) => [0x21, ...uleb(i)];
export const tee = (i) => [0x22, ...uleb(i)];

// Memoria. offset es una constante en bytes.
export const f32_load  = (offset = 0) => [0x2a, ...memarg(2, offset)];
export const f32_store = (offset = 0) => [0x38, ...memarg(2, offset)];
export const i32_load  = (offset = 0) => [0x28, ...memarg(2, offset)];

// Enteros
export const i32 = (n) => [0x41, ...sleb(n | 0)];
export const i32_eqz = () => [0x45];
export const i32_eq  = () => [0x46];
export const i32_ne  = () => [0x47];
export const i32_lt_s = () => [0x48];
export const i32_lt_u = () => [0x49];
export const i32_gt_s = () => [0x4a];
export const i32_ge_s = () => [0x4e];
export const i32_add = () => [0x6a];
export const i32_sub = () => [0x6b];
export const i32_mul = () => [0x6c];
export const i32_shl = () => [0x74];

// Flotantes de 32 bits
export const f32 = (x) => [0x43, ...f32bytes(x)];
export const f32_sqrt = () => [0x91];
export const f32_add  = () => [0x92];
export const f32_sub  = () => [0x93];
export const f32_mul  = () => [0x94];
export const f32_div  = () => [0x95];
export const f32_max  = () => [0x97];

// SIMD de 128 bits
export const v128_load         = (offset = 0) => [...simd(0x00), ...memarg(4, offset)];
export const v128_load32_splat = (offset = 0) => [...simd(0x09), ...memarg(2, offset)];
export const v128_store        = (offset = 0) => [...simd(0x0b), ...memarg(4, offset)];
export const v128_const0       = () => [...simd(0x0c), ...new Array(16).fill(0)];
export const f32x4_splat       = () => simd(0x13);
export const f32x4_extract     = (lane) => [...simd(0x1f), lane];
export const f32x4_add         = () => simd(0xe4);
export const f32x4_sub         = () => simd(0xe5);
export const f32x4_mul         = () => simd(0xe6);
export const f32x4_div         = () => simd(0xe7);
export const f32x4_max         = () => simd(0xe9);

// ── modulo ─────────────────────────────────────────────────────────────────
/**
 * @param memoria  { modulo, campo, paginasMin }  memoria importada (64 KiB por pagina)
 * @param funciones [{ nombre, params: [T...], resultados: [T...], locales: [[cantidad, T]...], cuerpo }]
 *                  todas exportadas con su nombre
 */
export function modulo({ memoria, funciones }) {
    const tipos = funciones.map((f) => [0x60, vec(f.params.map((t) => [t])), vec((f.resultados || []).map((t) => [t]))]);
    const importar = [nombre(memoria.modulo), nombre(memoria.campo), 0x02, 0x00, ...uleb(memoria.paginasMin)];
    const cuerpos = funciones.map((f) => {
        const locales = vec((f.locales || []).map(([n, t]) => [...uleb(n), t]));
        const b = [locales, f.cuerpo, 0x0b].flat(Infinity);
        return [...uleb(b.length), ...b];
    });
    const bytes = [
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
        ...seccion(1, vec(tipos)),
        ...seccion(2, vec([importar])),
        ...seccion(3, vec(funciones.map((_, i) => uleb(i)))),
        ...seccion(7, vec(funciones.map((f, i) => [...nombre(f.nombre), 0x00, ...uleb(i)]))),
        ...seccion(10, vec(cuerpos)),
    ];
    for (const b of bytes) if (!Number.isInteger(b) || b < 0 || b > 255) throw new Error(`byte invalido: ${b}`);
    return new Uint8Array(bytes);
}
