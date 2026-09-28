// ─────────────────────────────────────────────────────────────────────────────
// test-descarga-quieta.js — la descarga del modelo se corta solo si se queda
// quieta, no por su duracion total (cm-embed.js, bajar()).
//
// Tres servidores locales, con un limite de 1 s sin datos:
//   lento   : 3 MB en pedazos cada 100 ms (~5 s en total) -> tiene que terminar
//             entero, aunque tarde 5 veces el limite;
//   trabado : manda 200 KB y se calla con la conexion abierta -> corte a ~1 s;
//   mudo    : acepta la conexion y nunca responde -> corte a ~1 s.
//
//   node test/test-descarga-quieta.js
// ─────────────────────────────────────────────────────────────────────────────
"use strict";
const http = require("node:http");
const crypto = require("node:crypto");
const path = require("node:path");
const { bajar } = require(path.join(__dirname, "..", "cm-embed.js"));

let fallas = 0;
const check = (cond, texto) => { console.log(`${cond ? "OK  " : "MAL "} ${texto}`); if (!cond) fallas++; };

const DATOS = crypto.randomBytes(3 * 1024 * 1024);
const abiertas = new Set();
const srv = http.createServer((req, res) => {
    abiertas.add(res);
    if (req.url === "/lento") {
        res.writeHead(200, { "content-length": DATOS.length });
        let pos = 0;
        const t = setInterval(() => {
            if (pos >= DATOS.length) { clearInterval(t); res.end(); return; }
            res.write(DATOS.subarray(pos, pos + 64 * 1024)); pos += 64 * 1024;
        }, 100);
    } else if (req.url === "/trabado") {
        res.writeHead(200, { "content-length": DATOS.length });
        res.write(DATOS.subarray(0, 200 * 1024));   // y despues nada
    } else if (req.url === "/mudo") {
        // no responde nunca
    }
});

(async () => {
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const opciones = { sinDatosMs: 1000 };

    let t = Date.now();
    const lento = await bajar(`${base}/lento`, opciones).catch((e) => e);
    const segLento = (Date.now() - t) / 1000;
    check(Buffer.isBuffer(lento) && lento.equals(DATOS), `lento pero vivo: termino entero en ${segLento.toFixed(1)} s (limite de quietud 1 s)`);

    for (const caso of ["trabado", "mudo"]) {
        t = Date.now();
        const r = await bajar(`${base}/${caso}`, opciones).catch((e) => e);
        const seg = (Date.now() - t) / 1000;
        check(r instanceof Error && /sin recibir datos/.test(r.message) && seg < 3,
            `${caso}: cortado a los ${seg.toFixed(1)} s con "${r instanceof Error ? r.message.replace(base, "") : "sin error"}"`);
    }

    for (const res of abiertas) { try { res.destroy(); } catch (_) {} }
    srv.close();
    console.log(fallas ? `\n${fallas} FALLAS` : "\nOK: la descarga solo se corta si se queda quieta.");
    process.exit(fallas ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.stack || e); process.exit(1); });
