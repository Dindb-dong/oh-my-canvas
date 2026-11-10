// Pure reference helpers: safe to share with renderer/model code. Asset bytes live
// in the local asset store, never in these identifiers or the editable manifest.
const PREFIX = 'omc-asset:sha256:';
const HASH = /^[a-f0-9]{64}$/;

export function assetRef(hash) {
  if (!HASH.test(hash)) throw Error('Invalid asset hash');
  return PREFIX + hash;
}

export function parseAssetRef(value) {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return null;
  const hash = value.slice(PREFIX.length);
  if (!HASH.test(hash)) throw Error('Invalid asset reference');
  return hash;
}

export function collectAssetRefs(value, result = new Set(), seen = new WeakSet()) {
  if (typeof value === 'string') {
    const hash = parseAssetRef(value);
    if (hash) result.add(hash);
  } else if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const item of Object.values(value)) collectAssetRefs(item, result, seen);
  }
  return result;
}
