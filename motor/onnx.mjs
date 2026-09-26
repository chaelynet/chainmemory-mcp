// ─────────────────────────────────────────────────────────────────────────────
// onnx.mjs — lee un archivo .onnx (protobuf) sin librerias: los nodos del grafo
// y los pesos (initializers).
//
// Solo decodifica los campos que hacen falta (onnx.proto3):
//   ModelProto.graph = 7
//   GraphProto: node = 1, initializer = 5
//   NodeProto: input = 1, output = 2, name = 3, op_type = 4, attribute = 5
//   TensorProto: dims = 1, data_type = 2, float_data = 4, int32_data = 5,
//                int64_data = 7, name = 8, raw_data = 9
//   AttributeProto: name = 1, f = 2, i = 3, s = 4, t = 5, floats = 7, ints = 8
// ─────────────────────────────────────────────────────────────────────────────

const TIPOS = { 1: "float32", 6: "int32", 7: "int64", 9: "bool", 10: "float16", 11: "float64" };

// Lee los campos de un mensaje protobuf: devuelve [numero, tipo, valor] donde el
// valor es un BigInt (varint), un rango {ini, fin} (bytes) o los bytes fijos.
function* campos(buf, ini = 0, fin = buf.length) {
    let p = ini;
    const varint = () => {
        let x = 0n, s = 0n, b;
        do { b = buf[p++]; x |= BigInt(b & 0x7f) << s; s += 7n; } while (b & 0x80);
        return x;
    };
    while (p < fin) {
        const clave = Number(varint());
        const num = clave >>> 3, tipo = clave & 7;
        if (tipo === 0) yield [num, tipo, varint()];
        else if (tipo === 2) { const n = Number(varint()); yield [num, tipo, { ini: p, fin: p + n }]; p += n; }
        else if (tipo === 5) { yield [num, tipo, { ini: p, fin: p + 4 }]; p += 4; }
        else if (tipo === 1) { yield [num, tipo, { ini: p, fin: p + 8 }]; p += 8; }
        else throw new Error(`protobuf: tipo de campo ${tipo} no soportado`);
    }
}

const texto = (buf, r) => new TextDecoder().decode(buf.subarray(r.ini, r.fin));

function packedVarints(buf, r) {
    const out = [];
    let p = r.ini;
    while (p < r.fin) {
        let x = 0n, s = 0n, b;
        do { b = buf[p++]; x |= BigInt(b & 0x7f) << s; s += 7n; } while (b & 0x80);
        out.push(x);
    }
    return out;
}

function leerTensor(buf, r) {
    const t = { dims: [], tipo: null, nombre: "", datos: null };
    let raw = null;
    const floatData = [], int64Data = [], int32Data = [];
    for (const [num, tipo, v] of campos(buf, r.ini, r.fin)) {
        if (num === 1) { if (tipo === 2) t.dims.push(...packedVarints(buf, v).map(Number)); else t.dims.push(Number(v)); }
        else if (num === 2) t.tipo = TIPOS[Number(v)] || `tipo ${v}`;
        else if (num === 8) t.nombre = texto(buf, v);
        else if (num === 9) raw = v;
        else if (num === 4) {
            if (tipo === 2) { const dv = new DataView(buf.buffer, buf.byteOffset + v.ini, v.fin - v.ini); for (let i = 0; i < dv.byteLength; i += 4) floatData.push(dv.getFloat32(i, true)); }
            else floatData.push(new DataView(buf.buffer, buf.byteOffset + v.ini, 4).getFloat32(0, true));
        }
        else if (num === 7) { if (tipo === 2) int64Data.push(...packedVarints(buf, v)); else int64Data.push(BigInt.asIntN(64, v)); }
        else if (num === 5) { if (tipo === 2) int32Data.push(...packedVarints(buf, v).map((x) => Number(BigInt.asIntN(32, x)))); else int32Data.push(Number(v)); }
    }
    const n = t.dims.reduce((a, b) => a * b, 1);
    if (raw) {
        const bytes = buf.slice(raw.ini, raw.fin);          // copia alineada
        if (t.tipo === "float32") t.datos = new Float32Array(bytes.buffer);
        else if (t.tipo === "float16") t.datos = new Uint16Array(bytes.buffer);
        else if (t.tipo === "int64") t.datos = new BigInt64Array(bytes.buffer);
        else if (t.tipo === "int32") t.datos = new Int32Array(bytes.buffer);
        else t.datos = bytes;
    } else if (floatData.length) t.datos = Float32Array.from(floatData);
    else if (int64Data.length) t.datos = BigInt64Array.from(int64Data.map((x) => BigInt.asIntN(64, x)));
    else if (int32Data.length) t.datos = Int32Array.from(int32Data);
    if (t.datos && t.datos.length !== n && !(n === 1 && t.dims.length === 0)) {
        throw new Error(`tensor ${t.nombre}: ${t.datos.length} valores, se esperaban ${n}`);
    }
    return t;
}

function leerAtributo(buf, r) {
    const a = { nombre: "" };
    for (const [num, tipo, v] of campos(buf, r.ini, r.fin)) {
        if (num === 1) a.nombre = texto(buf, v);
        else if (num === 2) a.f = new DataView(buf.buffer, buf.byteOffset + v.ini, 4).getFloat32(0, true);
        else if (num === 3) a.i = Number(BigInt.asIntN(64, v));
        else if (num === 4) a.s = texto(buf, v);
        else if (num === 5) a.t = leerTensor(buf, v);
        else if (num === 8) (a.ints ||= []).push(...(tipo === 2 ? packedVarints(buf, v) : [v]).map((x) => Number(BigInt.asIntN(64, x))));
        else if (num === 7) (a.floats ||= []).push(new DataView(buf.buffer, buf.byteOffset + v.ini, 4).getFloat32(0, true));
    }
    return a;
}

function leerNodo(buf, r) {
    const n = { entradas: [], salidas: [], nombre: "", op: "", atributos: {} };
    for (const [num, , v] of campos(buf, r.ini, r.fin)) {
        if (num === 1) n.entradas.push(texto(buf, v));
        else if (num === 2) n.salidas.push(texto(buf, v));
        else if (num === 3) n.nombre = texto(buf, v);
        else if (num === 4) n.op = texto(buf, v);
        else if (num === 5) { const a = leerAtributo(buf, v); n.atributos[a.nombre] = a; }
    }
    return n;
}

/** @param bytes Uint8Array con el archivo .onnx completo */
export function leerOnnx(bytes) {
    let grafo = null;
    for (const [num, , v] of campos(bytes)) if (num === 7) grafo = v;
    if (!grafo) throw new Error("el archivo no tiene grafo");
    const nodos = [], pesos = new Map();
    for (const [num, , v] of campos(bytes, grafo.ini, grafo.fin)) {
        if (num === 1) nodos.push(leerNodo(bytes, v));
        else if (num === 5) { const t = leerTensor(bytes, v); pesos.set(t.nombre, t); }
    }
    return { nodos, pesos };
}

/** float16 (bits) -> float32, exacto */
export function f16aF32(bits) {
    const out = new Float32Array(bits.length);
    for (let i = 0; i < bits.length; i++) {
        const h = bits[i], s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
        out[i] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
    }
    return out;
}
