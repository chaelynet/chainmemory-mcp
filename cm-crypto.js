/**
 * cm-crypto.js — Núcleo criptográfico de la bóveda ciega de ChainMemory
 *
 * PORTABLE: corre idéntico en Node 20+ y en el navegador, porque usa
 * exclusivamente Web Crypto (globalThis.crypto.subtle). Cero dependencias
 * externas, cero CDN (respeta con_0005).
 *
 * Qué hace y qué NO hace:
 *   - Deriva la clave de contenido de la CLAVE PRIVADA del usuario (que el
 *     servidor nunca recibe), no de la api_key. Ese es el cambio que vuelve
 *     ciega la bóveda. Algoritmo: HKDF-SHA256.
 *   - Cifra y descifra con AES-256-GCM, mismo primitivo que el esquema actual.
 *   - Calcula eventHash = sha256(plaintext), igual semántica que el legacy,
 *     unificado en un solo lugar (cierra risk_0021).
 *   - NO genera ni recupera la frase de 12 palabras: eso lo hace cm-wallet.js
 *     apoyándose en ethers (BIP-39/BIP-32 auditado). No se reimplementa
 *     criptografía de semilla a mano.
 *
 * Formato del envoltorio (v2, bóveda ciega):
 *     VERSION(1 byte = 0x02) || IV(12) || ciphertext || tag(16)
 * El legacy (v1) es IV(12)||ct||tag(16) sin prefijo de versión y se sigue
 * descifrando por el camino viejo del servidor. El byte de versión hace que
 * cada blob diga qué es.
 */

const CM = (() => {
  const g = (typeof globalThis !== 'undefined') ? globalThis : this;
  const webcrypto = g.crypto;
  if (!webcrypto || !webcrypto.subtle) {
    throw new Error('cm-crypto: Web Crypto no disponible (requiere Node 20+ o navegador moderno)');
  }
  const subtle = webcrypto.subtle;
  const getRandom = (n) => webcrypto.getRandomValues(new Uint8Array(n));

  const VERSION = 0x02;
  const IV_LEN = 12;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const hex = {
    to: (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join(''),
    from: (h) => {
      h = String(h).replace(/^0x/, '');
      if (h.length % 2 !== 0) throw new Error('cm-crypto: hex de longitud impar');
      const u = new Uint8Array(h.length / 2);
      for (let i = 0; i < u.length; i++) u[i] = parseInt(h.substr(i * 2, 2), 16);
      return u;
    }
  };

  async function sha256(u8) {
    return new Uint8Array(await subtle.digest('SHA-256', u8));
  }

  /**
   * Deriva la clave AES-256 de contenido a partir de la SEMILLA BIP-39.
   * La semilla (64 bytes) sale de cm-bip39.mnemonicToSeed(frase). Es alta
   * entropía y única por usuario, así que el salt es fijo por versión (la
   * unicidad la aporta la semilla, no el salt).
   * @param {Uint8Array|string} seed  semilla de la frase (Uint8Array o hex)
   * @returns {Promise<CryptoKey>}     clave AES-GCM no exportable
   */
  async function deriveContentKey(seed) {
    const ikm = (seed instanceof Uint8Array) ? seed : hex.from(seed);
    if (ikm.length < 16) throw new Error('cm-crypto: la semilla es demasiado corta');
    const salt = await sha256(enc.encode('chainmemory-content-salt-v1'));
    const info = enc.encode('chainmemory-content-v1');
    const baseKey = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
    return subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt, info },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /**
   * Cifra un texto. Devuelve VERSION||IV||ct||tag como Uint8Array, listo para anclar.
   */
  async function encrypt(plaintext, key) {
    if (typeof plaintext !== 'string') throw new Error('cm-crypto: plaintext debe ser string');
    const iv = getRandom(IV_LEN);
    const ctTag = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext)));
    const out = new Uint8Array(1 + IV_LEN + ctTag.length);
    out[0] = VERSION;
    out.set(iv, 1);
    out.set(ctTag, 1 + IV_LEN);
    return out;
  }

  /**
   * Descifra un blob v2. Lanza si el tag GCM no valida (clave incorrecta o dato alterado).
   */
  async function decrypt(buf, key) {
    const u8 = (buf instanceof Uint8Array) ? buf : new Uint8Array(buf);
    if (u8.length < 1 + IV_LEN + 16 + 1) throw new Error('cm-crypto: blob demasiado corto');
    if (u8[0] !== VERSION) throw new Error('cm-crypto: versión de envoltorio desconocida: ' + u8[0]);
    const iv = u8.slice(1, 1 + IV_LEN);
    const ctTag = u8.slice(1 + IV_LEN);
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv }, key, ctTag);
    return dec.decode(new Uint8Array(pt));
  }

  /**
   * eventHash = sha256(plaintext), en hex sin prefijo 0x. Misma semántica que el
   * legacy (api/lib/crypto.js:eventHash). Se calcula en el cliente, que tiene el
   * texto en claro; no expone nada porque es un hash de una vía.
   */
  async function eventHash(plaintext) {
    return hex.to(await sha256(enc.encode(plaintext)));
  }

  return { deriveContentKey, encrypt, decrypt, eventHash, hex, VERSION, IV_LEN };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CM;
if (typeof globalThis !== 'undefined') globalThis.CMCrypto = CM;
