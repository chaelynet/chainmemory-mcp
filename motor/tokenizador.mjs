// ─────────────────────────────────────────────────────────────────────────────
// tokenizador.mjs — convierte un texto en los numeros de token que espera el
// modelo all-MiniLM-L6-v2, sin codigo de terceros.
//
// Replica el tokenizador BERT que usa el servidor (sentence-transformers sobre la
// libreria "tokenizers" de Hugging Face), paso por paso, con la configuracion de
// tokenizer.json del modelo:
//   1. normalizar (BertNormalizer: clean_text, chinese chars, quitar acentos,
//      minusculas)
//   2. separar en palabras (BertPreTokenizer: espacios y signos de puntuacion)
//   3. partir cada palabra en piezas del vocabulario (WordPiece, "##", maximo 100
//      caracteres por palabra)
//   4. [CLS] + hasta 254 tokens + [SEP], el mismo corte de 256 que el servidor
//
// El vocabulario sale de tokenizer.json, que es uno de los archivos verificados
// contra el hash anclado en la cadena.
// ─────────────────────────────────────────────────────────────────────────────

import { BORRA, ESPACIO_NORM, CHINO, PUNTUACION, ESPACIO, MAPA } from "./tablas-unicode.mjs";

export const MAX_TOKENS = 256;
const MAX_CARACTERES_PALABRA = 100;
const PREFIJO = "##";

// ── normalizacion ───────────────────────────────────────────────────────────
// Cada caracter se resuelve con tablas propias (tablas-unicode.mjs), sacadas del
// tokenizador del servidor caracter por caracter. No se usan las tablas de
// Unicode del navegador: cambian con cada version de Chrome y no coinciden con
// las del servidor, que son de una version vieja de Unicode.

function enRangos(rangos, cp) {
    let lo = 0, hi = rangos.length - 1;
    while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (cp < rangos[m][0]) hi = m - 1;
        else if (cp > rangos[m][1]) lo = m + 1;
        else return true;
    }
    return false;
}
const MAPA_CP = new Map(Object.entries(MAPA).map(([k, v]) => [parseInt(k, 16), v]));

function hangul(cp) {
    const s = cp - 0xac00;
    const t = 0x11a7 + (s % 28);
    return String.fromCodePoint(0x1100 + Math.floor(s / 588), 0x1161 + Math.floor((s % 588) / 28)) +
           (t !== 0x11a7 ? String.fromCodePoint(t) : "");
}

/** lo que hace el normalizador del servidor con un solo caracter */
function normalizarCaracter(c) {
    const cp = c.codePointAt(0);
    if (enRangos(BORRA, cp)) return "";
    if (enRangos(ESPACIO_NORM, cp)) return " ";
    const m = MAPA_CP.get(cp);
    if (m !== undefined) return m;
    if (enRangos(CHINO, cp)) return ` ${c} `;
    if (cp >= 0xac00 && cp <= 0xd7a3) return hangul(cp);
    return c;
}

export function normalizar(texto) {
    // Un subrogado suelto no existe en UTF-8: llega al servidor como U+FFFD, que
    // el normalizador borra. toWellFormed hace ese mismo reemplazo.
    let s = "";
    for (const c of String(texto).toWellFormed()) s += normalizarCaracter(c);
    return s;
}

const esEspacio = (c) => enRangos(ESPACIO, c.codePointAt(0));
const esPuntuacion = (c) => enRangos(PUNTUACION, c.codePointAt(0));

export function separarPalabras(texto) {
    const palabras = [];
    let actual = "";
    for (const c of texto) {
        if (esEspacio(c)) {
            if (actual) { palabras.push(actual); actual = ""; }
        } else if (esPuntuacion(c)) {
            if (actual) { palabras.push(actual); actual = ""; }
            palabras.push(c);
        } else {
            actual += c;
        }
    }
    if (actual) palabras.push(actual);
    return palabras;
}

// ── tokenizador ─────────────────────────────────────────────────────────────
/**
 * @param tokenizerJson  el contenido de tokenizer.json ya parseado
 */
export function crearTokenizador(tokenizerJson) {
    const m = tokenizerJson.model;
    if (!m || m.type !== "WordPiece" || m.continuing_subword_prefix !== PREFIJO || m.max_input_chars_per_word !== MAX_CARACTERES_PALABRA) {
        throw new Error("tokenizer.json no es el WordPiece esperado");
    }
    const vocab = new Map(Object.entries(m.vocab));
    const id = (t) => { const x = vocab.get(t); if (x === undefined) throw new Error(`falta ${t} en el vocabulario`); return x; };
    const UNK = id("[UNK]"), CLS = id("[CLS]"), SEP = id("[SEP]");

    function wordpiece(palabra, salida) {
        const chars = Array.from(palabra);
        if (chars.length > MAX_CARACTERES_PALABRA) { salida.push(UNK); return; }
        const piezas = [];
        let inicio = 0;
        while (inicio < chars.length) {
            let fin = chars.length, encontrada = -1;
            while (inicio < fin) {
                let sub = chars.slice(inicio, fin).join("");
                if (inicio > 0) sub = PREFIJO + sub;
                const x = vocab.get(sub);
                if (x !== undefined) { encontrada = x; break; }
                fin--;
            }
            if (encontrada < 0) { salida.push(UNK); return; }     // una pieza imposible: toda la palabra es [UNK]
            piezas.push(encontrada);
            inicio = fin;
        }
        salida.push(...piezas);
    }

    // Tokens especiales escritos dentro del texto ("[SEP]", "[CLS]", ...): el
    // servidor los reconoce en el texto original, antes de normalizar, tal cual
    // (mayusculas y corchetes), en cualquier lugar, aunque esten pegados a otra
    // palabra, y los convierte en su numero. El resto del texto se procesa por
    // tramos entre ellos. Se leen de added_tokens de tokenizer.json.
    const especiales = new Map();
    for (const a of tokenizerJson.added_tokens || []) {
        if (a.normalized || a.lstrip || a.rstrip || a.single_word) {
            throw new Error(`token agregado ${a.content} con opciones no soportadas`);
        }
        especiales.set(a.content, a.id);
    }
    const escapar = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const RE_ESPECIAL = especiales.size
        ? new RegExp([...especiales.keys()].sort((a, b) => b.length - a.length).map(escapar).join("|"), "g")
        : null;

    function tramo(texto, salida) {
        for (const p of separarPalabras(normalizar(texto))) wordpiece(p, salida);
    }

    /** tokens del contenido, sin [CLS]/[SEP] ni corte */
    function tokens(texto) {
        const s = String(texto ?? "");
        const salida = [];
        if (!RE_ESPECIAL) { tramo(s, salida); return salida; }
        let desde = 0;
        for (const m of s.matchAll(RE_ESPECIAL)) {
            tramo(s.slice(desde, m.index), salida);
            salida.push(especiales.get(m[0]));
            desde = m.index + m[0].length;
        }
        tramo(s.slice(desde), salida);
        return salida;
    }

    /** lo que entra al modelo: [CLS] + hasta 254 tokens + [SEP] */
    function paraModelo(texto) {
        return [CLS, ...tokens(texto).slice(0, MAX_TOKENS - 2), SEP];
    }

    return { tokens, paraModelo, UNK, CLS, SEP };
}
