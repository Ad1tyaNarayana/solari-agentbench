export function canonicalizeCredentialKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const credentialKeys = new Set([
  "auth",
  "authorization",
  "key",
  "sig",
  "token",
  "pttoken",
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
  "xamzcredential",
  "xamzsecuritytoken",
  "xamzsignature",
  "password",
  "passphrase",
]);

export function isCredentialShapedKey(key: string): boolean {
  return credentialKeys.has(canonicalizeCredentialKey(key));
}
