/**
 * cm-bip39.js — Frase de 12 palabras (BIP-39) para ChainMemory, CERO DEPENDENCIAS.
 *
 * Solo Web Crypto (Node 20+ y navegador) + la lista oficial de 2048 palabras
 * (cm-wordlist.js). No usa ethers ni ninguna librería externa.
 *
 * Hace:
 *   - generateMnemonic()        -> 12 palabras nuevas (128 bits de entropía)
 *   - validateMnemonic(frase)   -> true/false (valida el checksum BIP-39)
 *   - mnemonicToSeed(frase, pp) -> semilla de 64 bytes (PBKDF2-HMAC-SHA512, 2048 iters)
 *   - entropyToMnemonic(bytes)  -> para reproducir vectores de prueba
 *
 * La semilla que devuelve mnemonicToSeed es la que alimenta a
 * cm-crypto.deriveContentKey(seed). Las 12 palabras son compatibles con
 * cualquier wallet estándar (MetaMask, Ledger): mismas palabras, misma cuenta.
 *
 * NO deriva la address de Ethereum ni firma transacciones: eso necesita
 * secp256k1 (curva elíptica) y NO se reimplementa a mano. La bóveda ciega no
 * lo necesita: cifra con la semilla y le manda al servidor un blob opaco.
 */

const WORDLIST = (typeof require === 'function') ? require('./cm-wordlist.js') : globalThis.CM_WORDLIST;

const CMBip39 = (() => {
  const g = (typeof globalThis !== 'undefined') ? globalThis : this;
  const wc = g.crypto;
  if (!wc || !wc.subtle) throw new Error('cm-bip39: Web Crypto no disponible (Node 20+ o navegador moderno)');
  const subtle = wc.subtle;
  const enc = new TextEncoder();

  if (!Array.isArray(WORDLIST) || WORDLIST.length !== 2048) {
    throw new Error('cm-bip39: la lista de palabras debe tener exactamente 2048 entradas');
  }

  async function sha256(u8) { return new Uint8Array(await subtle.digest('SHA-256', u8)); }

  function bytesToBits(u8) {
    let bits = '';
    for (const b of u8) bits += b.toString(2).padStart(8, '0');
    return bits;
  }

  const norm = (s) => String(s == null ? '' : s).normalize('NFKD');

  /**
   * Convierte 16 bytes de entropía (128 bits) en 12 palabras. Determinista:
   * sirve para reproducir los vectores estándar.
   */
  async function entropyToMnemonic(entropy) {
    if (!(entropy instanceof Uint8Array) || entropy.length !== 16) {
      throw new Error('cm-bip39: se soportan 128 bits (16 bytes) = 12 palabras');
    }
    const hash = await sha256(entropy);
    const csLen = (entropy.length * 8) / 32;          // 4 bits de checksum
    const bits = bytesToBits(entropy) + bytesToBits(hash).slice(0, csLen); // 132 bits
    const words = [];
    for (let i = 0; i < bits.length / 11; i++) {
      words.push(WORDLIST[parseInt(bits.slice(i * 11, (i + 1) * 11), 2)]);
    }
    return words.join(' ');
  }

  /** Genera 12 palabras nuevas con entropía criptográfica del sistema. */
  async function generateMnemonic() {
    return entropyToMnemonic(wc.getRandomValues(new Uint8Array(16)));
  }

  /** Valida que la frase sea BIP-39 correcta (palabras conocidas + checksum). */
  async function validateMnemonic(mnemonic) {
    const words = norm(mnemonic).trim().toLowerCase().split(/\s+/);
    if (words.length !== 12) return false;
    let bits = '';
    for (const w of words) {
      const idx = WORDLIST.indexOf(w);
      if (idx < 0) return false;
      bits += idx.toString(2).padStart(11, '0');
    }
    const entLen = Math.floor(bits.length / 33) * 32; // 128
    const entBits = bits.slice(0, entLen);
    const csBits = bits.slice(entLen);
    const entropy = new Uint8Array(entLen / 8);
    for (let i = 0; i < entropy.length; i++) entropy[i] = parseInt(entBits.slice(i * 8, i * 8 + 8), 2);
    const hash = await sha256(entropy);
    return bytesToBits(hash).slice(0, csBits.length) === csBits;
  }

  /**
   * Deriva la semilla de 64 bytes de la frase (PBKDF2-HMAC-SHA512, 2048 iters,
   * salt = "mnemonic"+passphrase). Estándar BIP-39.
   */
  async function mnemonicToSeed(mnemonic, passphrase) {
    const mnem = norm(mnemonic).trim().replace(/\s+/g, ' ');
    const salt = enc.encode('mnemonic' + norm(passphrase));
    const baseKey = await subtle.importKey('raw', enc.encode(mnem), 'PBKDF2', false, ['deriveBits']);
    const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-512', salt, iterations: 2048 }, baseKey, 512);
    return new Uint8Array(bits);
  }

  const hex = { to: (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('') };

  return { generateMnemonic, entropyToMnemonic, validateMnemonic, mnemonicToSeed, hex, WORDLIST_SIZE: WORDLIST.length };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CMBip39;
if (typeof globalThis !== 'undefined') globalThis.CMBip39 = CMBip39;
