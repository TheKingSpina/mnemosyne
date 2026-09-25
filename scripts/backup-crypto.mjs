import { Buffer } from 'node:buffer';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCallback,
} from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const magic = Buffer.from('MNSBKUP1');
const headerLengthSize = 4;
const saltSize = 16;
const nonceSize = 12;
const tagSize = 16;

export async function encryptBackup(plain, passphrase) {
  validatePassphrase(passphrase);
  const salt = randomBytes(saltSize);
  const nonce = randomBytes(nonceSize);
  const header = Buffer.from(
    JSON.stringify({
      format: 'mnemosyne-postgres-backup',
      version: 1,
      salt: salt.toString('base64url'),
      nonce: nonce.toString('base64url'),
    }),
    'utf8',
  );
  const headerLength = Buffer.alloc(headerLengthSize);
  headerLength.writeUInt32BE(header.length);
  const authenticatedHeader = Buffer.concat([magic, headerLength, header]);
  const key = await deriveKey(passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(authenticatedHeader);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([authenticatedHeader, ciphertext, tag]);
}

export async function decryptBackup(payload, passphrase) {
  validatePassphrase(passphrase);
  if (payload.length < magic.length + headerLengthSize + saltSize + nonceSize + tagSize) {
    throw new Error('backup_ciphertext_invalid');
  }
  if (!payload.subarray(0, magic.length).equals(magic)) throw new Error('backup_format_invalid');
  const headerLength = payload.readUInt32BE(magic.length);
  const headerStart = magic.length + headerLengthSize;
  const headerEnd = headerStart + headerLength;
  if (headerLength < 1 || headerEnd > payload.length - saltSize - nonceSize - tagSize) {
    throw new Error('backup_ciphertext_invalid');
  }
  let header;
  try {
    header = JSON.parse(payload.subarray(headerStart, headerEnd).toString('utf8'));
  } catch {
    throw new Error('backup_format_invalid');
  }
  if (header?.format !== 'mnemosyne-postgres-backup' || header.version !== 1) {
    throw new Error('backup_format_unsupported');
  }
  let salt;
  let nonce;
  try {
    salt = Buffer.from(header.salt, 'base64url');
    nonce = Buffer.from(header.nonce, 'base64url');
  } catch {
    throw new Error('backup_format_invalid');
  }
  if (salt.length !== saltSize || nonce.length !== nonceSize)
    throw new Error('backup_format_invalid');
  const authenticatedHeader = payload.subarray(0, headerEnd);
  const ciphertextStart = headerEnd;
  const ciphertextEnd = payload.length - tagSize;
  const key = await deriveKey(passphrase, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(authenticatedHeader);
  decipher.setAuthTag(payload.subarray(ciphertextEnd));
  try {
    return Buffer.concat([
      decipher.update(payload.subarray(ciphertextStart, ciphertextEnd)),
      decipher.final(),
    ]);
  } catch {
    throw new Error('backup_decryption_failed');
  }
}

export async function readBackupPassphrase(path) {
  const value = (await readFile(path, 'utf8')).replace(/[\r\n]+$/u, '');
  validatePassphrase(value);
  return value;
}

async function deriveKey(passphrase, salt) {
  return Buffer.from(await scrypt(passphrase, salt, 32));
}

function validatePassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 16) {
    throw new Error('backup_passphrase_too_short');
  }
}
