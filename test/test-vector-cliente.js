// ─────────────────────────────────────────────────────────────────────────────
// test-vector-cliente.js — el vector que calcula el MCP es el del servidor.
//
// Si se desvia, la busqueda no falla: empeora en silencio, porque las memorias
// nuevas dejan de ser comparables con las que ya estan guardadas. Por eso se
// compara contra vectores REALES del servidor (test/referencia-vectores.json,
// generado pidiendoselos al embedder de produccion).
//
// transformers.js no es dependencia del paquete: son ~622 MB en Node. Si no esta
// instalado, esta prueba verifica en cambio que la degradacion sea la correcta
// —que no rompa y que explique por que— y avisa que la parte de los vectores no
// se corrio.
//
//   node test/test-vector-cliente.js
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const cmEmbed = require('../cm-embed.js');

const REFERENCIA = path.join(__dirname, 'referencia-vectores.json');
const UMBRAL = 0.9999;

function coseno(a, b) {
    let n = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { n += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return n / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

(async () => {
    const emb = await cmEmbed.crearEmbedder();

    if (!emb) {
        const motivo = cmEmbed.motivoNoDisponible() || '';
        console.log('transformers.js no esta instalado: se prueba la degradacion.');
        assert.match(motivo, /@huggingface\/transformers is not installed/, 'el motivo no explica que falta');
        assert.match(motivo, /npm i -g @huggingface\/transformers/, 'el motivo no dice como habilitarlo');
        assert.match(motivo, /encrypted/, 'el motivo no aclara que la memoria igual se guarda cifrada');
        console.log('  degradacion OK: devuelve null y explica que falta, como habilitarlo y que la memoria igual se guarda cifrada.');
        console.log('\nAVISO: la comparacion de vectores NO se corrio. Para correrla:');
        console.log('  npm i @huggingface/transformers   (unos 600 MB)  y volver a ejecutar.');
        return;
    }

    const ref = JSON.parse(fs.readFileSync(REFERENCIA, 'utf8'));
    console.log(`comparando ${ref.casos.length} textos contra el vector del servidor (${ref.fuente})`);
    const sims = [];
    for (const c of ref.casos) {
        const v = await emb.embed(c.texto);
        assert.strictEqual(v.length, cmEmbed.DIM, 'dimensiones distintas');
        sims.push({ sim: coseno(v, c.vector), texto: c.texto });
    }
    sims.sort((a, b) => a.sim - b.sim);
    const peor = sims[0];
    console.log(`  peor coseno: ${peor.sim.toFixed(6)}  (${peor.texto.length} caracteres)`);
    console.log(`  mediana    : ${sims[Math.floor(sims.length / 2)].sim.toFixed(6)}`);
    assert.ok(peor.sim >= UMBRAL,
        `el peor coseno es ${peor.sim.toFixed(6)}, se espera >= ${UMBRAL}. El vector del cliente dejo de ser el del servidor.`);
    console.log('\nOK: el vector del MCP es el del servidor.');
})().catch(e => { console.error('FALLA:', e.message); process.exit(1); });
