// Verschlüsselt die Statistiken mit einem Passwort (PBKDF2 + AES-256-GCM, wie im Browser per WebCrypto)
const ITERATIONS = 600_000; // macht Passwort-Durchprobieren absichtlich langsam

const b64 = (bytes) => Buffer.from(bytes).toString('base64');

export async function encryptJson(data, password, salt) {
  const { subtle } = globalThis.crypto;
  const baseKey = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const cipher = await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(data)));
  return { v: 1, iterations: ITERATIONS, salt: b64(salt), iv: b64(iv), data: b64(new Uint8Array(cipher)) };
}
