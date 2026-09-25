import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { decryptBackup, encryptBackup } from './backup-crypto.mjs';

const passphrase = 'backup-passphrase-long-enough-for-tests';

describe('backup encryption', () => {
  it('round-trips a backup with authenticated encryption', async () => {
    const plaintext = Buffer.from('synthetic PostgreSQL backup payload');

    const encrypted = await encryptBackup(plaintext, passphrase);

    expect(encrypted).not.toEqual(plaintext);
    await expect(decryptBackup(encrypted, passphrase)).resolves.toEqual(plaintext);
  });

  it('rejects tampered ciphertext and an incorrect passphrase', async () => {
    const encrypted = await encryptBackup(
      Buffer.from('synthetic payload with enough bytes for authenticated encryption checks'),
      passphrase,
    );
    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1] ^= 1;

    await expect(decryptBackup(tampered, passphrase)).rejects.toThrow('backup_decryption_failed');
    await expect(decryptBackup(encrypted, 'another-passphrase-long-enough')).rejects.toThrow(
      'backup_decryption_failed',
    );
  });
});
