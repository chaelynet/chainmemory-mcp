/**
 * cm-client.js — Ayudante de cliente para la bóveda ciega. CERO DEPENDENCIAS.
 *
 * Envuelve cm-crypto + cm-bip39 en las dos operaciones que un cliente (el MCP,
 * la extensión) necesita, inicializado con la frase de 12 palabras del usuario:
 *
 *   const client = await CMClient.fromMnemonic("word1 ... word12");
 *   const sealed = await client.seal("texto");   // { blob_b64, event_hash, plain_len }
 *   const text   = await client.open(sealed.blob_b64);   // "texto"
 *
 * Portable: funciona igual en Node (MCP) y en el navegador (extensión). Usa
 * Buffer si existe, si no btoa/atob. No importa ninguna librería externa.
 *
 * Todo va dentro de un IIFE: en una extensión, los content scripts comparten
 * el scope global, así que NO se deja ninguna variable de nivel superior suelta
 * (evita colisiones como "Identifier 'CM' has already been declared").
 */
(function () {
  const __cmBip = (typeof require === 'function') ? require('./cm-bip39.js') : globalThis.CMBip39;
  const __cmCrypto = (typeof require === 'function') ? require('./cm-crypto.js') : globalThis.CMCrypto;

  function u8ToB64(u8) {
    if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64');
    let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s);
  }
  function b64ToU8(b64) {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
    const s = atob(b64); const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u;
  }

  class CMClient {
    constructor(key) { this._key = key; }

    /** Crea un cliente a partir de la frase de 12 palabras. Deriva la clave una sola vez. */
    static async fromMnemonic(mnemonic, passphrase) {
      if (!(await __cmBip.validateMnemonic(mnemonic))) {
        throw new Error('cm-client: la frase de 12 palabras no es válida (revisá el orden y la ortografía)');
      }
      const seed = await __cmBip.mnemonicToSeed(mnemonic, passphrase || '');
      return new CMClient(await __cmCrypto.deriveContentKey(seed));
    }

    /** Cifra un texto y devuelve lo que espera POST /v1/memory/sealed. */
    async seal(plaintext) {
      if (typeof plaintext !== 'string') throw new Error('cm-client: seal espera un string');
      const blob = await __cmCrypto.encrypt(plaintext, this._key);
      return {
        blob_b64: u8ToB64(blob),
        event_hash: await __cmCrypto.eventHash(plaintext),
        plain_len: new TextEncoder().encode(plaintext).length
      };
    }

    /** Descifra un blob (base64) que devolvió el servidor. */
    async open(blob_b64) {
      return __cmCrypto.decrypt(b64ToU8(blob_b64), this._key);
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = CMClient;
  if (typeof globalThis !== 'undefined') globalThis.CMClient = CMClient;
})();
