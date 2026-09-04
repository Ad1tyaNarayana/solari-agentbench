export function canonicalizeCredentialKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const credentialKeys = new Set([
  "auth",
  "authorization",
  "key",
  "sig",
  "token",
  "accesstoken",
  "authtoken",
  "bearertoken",
  "refreshtoken",
  "idtoken",
  "sessiontoken",
  "apikey",
  "jwt",
  "secret",
  "clientsecret",
  "signature",
  "credential",
  "password",
  "passphrase",
]);

export function isCredentialShapedKey(key: string): boolean {
  return credentialKeys.has(canonicalizeCredentialKey(key));
}
