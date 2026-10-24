/**
 * Where `authedFetch` gets the private key for shared-dashboard requests.
 *
 * The resolver is injected at app boot (see `installRequestContext`) so the
 * HTTP primitive itself does not reach into routing or the Zustand store — the
 * fetch path stays substitutable in tests.
 */
type PrivateKeyResolver = () => string | null;

let resolvePrivateKey: PrivateKeyResolver = () => null;
const privateKeyScopes = new Map<string, string>();
const MAX_PRIVATE_KEY_SCOPES = 128;
const cacheScopeNamespace = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
let privateKeyScopeCount = 0;

export function setPrivateKeyResolver(resolver: PrivateKeyResolver) {
  resolvePrivateKey = resolver;
}

export function getRequestPrivateKey(): string | null {
  return resolvePrivateKey();
}

// Cache identities must distinguish shared links without copying their bearer
// credentials into query keys/devtools. Bound retained keys; evicted links get
// fresh, never-reused identities when reopened, so old caches cannot collide.
export function getRequestCacheScope(privateKey: string | null): string {
  if (!privateKey) return "default";
  let scope = privateKeyScopes.get(privateKey);
  if (!scope) {
    if (privateKeyScopeCount === Number.MAX_SAFE_INTEGER) throw new Error("Private link cache scope limit reached");
    scope = `shared:${cacheScopeNamespace}:${++privateKeyScopeCount}`;
  } else {
    privateKeyScopes.delete(privateKey);
  }
  privateKeyScopes.set(privateKey, scope);
  if (privateKeyScopes.size > MAX_PRIVATE_KEY_SCOPES) privateKeyScopes.delete(privateKeyScopes.keys().next().value!);
  return scope;
}
