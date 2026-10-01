export const MIN_PASSWORD_LENGTH = 8;
export const PASSWORD_ITERATIONS = 600_000;

export interface PasswordParameters {
  salt: string;
  iterations: number;
  clientHash: boolean;
}

export interface PasswordProof {
  derived: string;
  salt: string;
  iterations: number;
  length: number;
}

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export async function derivePasswordHash(
  password: string,
  salt: string,
  iterations = PASSWORD_ITERATIONS,
): Promise<string> {
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > PASSWORD_ITERATIONS)
    throw new Error('密码参数无效，请刷新页面后重试。');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bytes = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: Uint8Array.from(atob(salt.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
        c.charCodeAt(0),
      ),
      iterations,
    },
    key,
    256,
  );
  return encode(new Uint8Array(bytes));
}

// The browser performs the expensive KDF. Only a server-keyed verifier is stored.
// Old local databases still send a password once so the server can upgrade them.
export async function preparePassword(
  password: string,
  parameters?: PasswordParameters,
): Promise<PasswordProof | string> {
  if (parameters && !parameters.clientHash) return password;
  const salt = parameters?.salt ?? encode(crypto.getRandomValues(new Uint8Array(16)));
  const iterations = parameters?.iterations ?? PASSWORD_ITERATIONS;
  return {
    derived: await derivePasswordHash(password, salt, iterations),
    salt,
    iterations,
    length: [...password].length,
  };
}
