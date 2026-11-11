import { createHash } from 'node:crypto';
import { assertDocument } from './document.mjs';
import { parseAssetRef } from './asset-refs.mjs';

// Optional presentation data. These limits are deliberately independent of the
// document/CRDT limits: a large first page simply uses the normal loading path.
export const MAX_PREVIEW_DOCUMENT_BYTES = 16 * 1024 * 1024;
export const MAX_PREVIEW_HEADER_BYTES = 1024 * 1024;
export const MAX_PREVIEW_BYTES = MAX_PREVIEW_DOCUMENT_BYTES + MAX_PREVIEW_HEADER_BYTES + 4;
export const MAX_PREVIEW_JOURNAL_BYTES = 16 * 1024 * 1024;
const FORMAT = 'oh-my-canvas-preview';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);
const tokenFields = ['id', 'generation', 'checkpointSha256', 'manifestSha256', 'journalSequence', 'journalBytes', 'journalSha256', 'source'];

export function matchingPreviewTokens(a, b) {
  return !!a && !!b && tokenFields.every(key => a[key] !== undefined && a[key] === b[key]);
}

/** Capture just the real first page and shared definitions. Inactive dependency
 * pages are not a safe substitute for loaded authoritative pages. */
export function capturePreview(document) {
  const pageId = document?.pages?.[0], page = document?.pagesById?.[pageId];
  if (!page || document.pages.length > 100) return null;
  for (const component of Object.values(document.components ?? {})) {
    if (component && !component.deleted && component.mainPageId !== pageId) return null;
  }
  const pages = [];
  for (const id of document.pages) {
    const name = document.pagesById[id]?.name ?? '';
    if (typeof id !== 'string' || !id || id.length > 1024 || typeof name !== 'string' || name.length > 1024) return null;
    pages.push({ id, name });
  }
  return { pageId, pages, document: { ...document, pages: [pageId], pagesById: { [pageId]: page } } };
}

function assertPage(document, pageId) {
  if (document.pages.length !== 1 || document.pages[0] !== pageId || Object.keys(document.pagesById).length !== 1) throw Error('Invalid preview page subset');
  const page = document.pagesById[pageId], objects = page?.objects;
  if (page?.id !== pageId || objects?.root?.parentId !== 'root' || !Array.isArray(objects.root.childIds)) throw Error('Invalid preview root');
  const visited = new Set(), pending = ['root'];
  while (pending.length) {
    const id = pending.pop(), shape = objects[id];
    if (typeof id !== 'string' || !shape || visited.has(id)) throw Error('Invalid preview page graph');
    visited.add(id);
    if (shape.childIds !== undefined) {
      if (!Array.isArray(shape.childIds) || !['frame', 'group', 'boolean'].includes(shape.type)) throw Error('Invalid preview children');
      for (const child of shape.childIds) {
        if (objects[child]?.parentId !== id) throw Error('Invalid preview parent');
        pending.push(child);
      }
    }
  }
  if (visited.size !== Object.keys(objects).length) throw Error('Invalid preview orphan');
}

/** Verify only dependencies needed by the page/shared definitions. The complete
 * asset catalog is preserved, but reading every unused bitmap defeats a preview. */
export function previewAssetHashes(document) {
  const hashes = new Set(), visited = new WeakSet(), assets = document.assets ?? {};
  function visit(value) {
    if (typeof value === 'string') { const ref = parseAssetRef(value); if (ref) hashes.add(ref); return; }
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    if (own(value, 'assetId')) {
      if (typeof value.assetId !== 'string' || !own(assets, value.assetId)) throw Error('Missing preview image asset');
      visit(assets[value.assetId]);
    }
    for (const item of Object.values(value)) visit(item);
  }
  for (const [key, value] of Object.entries(document)) if (key !== 'assets') visit(value);
  return [...hashes].sort();
}

export function serializePreview(projection) {
  // Stop oversized scalar/catalog data during traversal, before JSON.stringify
  // can allocate a full document-sized result for this optional cache.
  let minimumBytes = 0;
  const json = JSON.stringify(projection.document, (key, value) => {
    minimumBytes += key.length + (typeof value === 'string' ? value.length + 2 : 1);
    if (minimumBytes > MAX_PREVIEW_DOCUMENT_BYTES) throw Error('Preview exceeds its size limit');
    return value;
  });
  if (Buffer.byteLength(json) > MAX_PREVIEW_DOCUMENT_BYTES) throw Error('Preview exceeds its size limit');
  const body = Buffer.from(json);
  return { body, documentSha256: hash(body), assetHashes: previewAssetHashes(projection.document) };
}

export function encodePreview(projection, token, serialized) {
  const header = Buffer.from(JSON.stringify({ format: FORMAT, version: 1, token, pageId: projection.pageId, pages: projection.pages,
    documentBytes: serialized.body.length, documentSha256: serialized.documentSha256, assetHashes: serialized.assetHashes }));
  if (header.length > MAX_PREVIEW_HEADER_BYTES) throw Error('Preview header exceeds its size limit');
  const prefix = Buffer.allocUnsafe(4); prefix.writeUInt32BE(header.length);
  return Buffer.concat([prefix, header, serialized.body]);
}

export function decodePreview(bytes) {
  if (bytes.length < 4 || bytes.length > MAX_PREVIEW_BYTES) throw Error('Invalid preview size');
  const headerLength = bytes.readUInt32BE(0), offset = headerLength + 4;
  if (!headerLength || headerLength > MAX_PREVIEW_HEADER_BYTES || offset > bytes.length) throw Error('Invalid preview header');
  const header = JSON.parse(bytes.subarray(4, offset).toString('utf8')), body = bytes.subarray(offset);
  if (header?.format !== FORMAT || header.version !== 1 || body.length > MAX_PREVIEW_DOCUMENT_BYTES || header.documentBytes !== body.length || header.documentSha256 !== hash(body)) throw Error('Damaged preview document');
  if (!Array.isArray(header.pages) || !header.pages.length || header.pages.length > 100 || header.pages[0]?.id !== header.pageId || new Set(header.pages.map(page => page?.id)).size !== header.pages.length) throw Error('Invalid preview pages');
  for (const page of header.pages) if (!page || typeof page.id !== 'string' || !page.id || page.id.length > 1024 || typeof page.name !== 'string' || page.name.length > 1024) throw Error('Invalid preview page metadata');
  const document = assertDocument(JSON.parse(body.toString('utf8')));
  assertPage(document, header.pageId);
  if (!capturePreview(document)) throw Error('Unloaded preview component dependency');
  const hashes = previewAssetHashes(document);
  if (!Array.isArray(header.assetHashes) || hashes.length !== header.assetHashes.length || hashes.some((value, index) => value !== header.assetHashes[index])) throw Error('Invalid preview assets');
  if ((document.pagesById[header.pageId].name ?? '') !== header.pages[0].name) throw Error('Invalid preview page name');
  return { document, pageId: header.pageId, pages: header.pages, token: header.token, assetHashes: hashes };
}

// Body reuse uses only immutable branch identity. Weak references avoid keeping
// closed document graphs alive; both serialized bytes and entry count are bound.
export function previewSignature(document) {
  return Object.entries(document).filter(([key]) => key !== 'pages').map(([key, value]) => {
    if (key === 'pagesById') value = document.pagesById[document.pages[0]];
    return [key, value && typeof value === 'object' ? new WeakRef(value) : value];
  });
}
export function samePreviewSignature(signature, document) {
  const entries = Object.entries(document).filter(([key]) => key !== 'pages');
  return entries.length === signature.length && signature.every(([key, reference], index) => {
    if (entries[index][0] !== key) return false;
    const value = key === 'pagesById' ? document.pagesById[document.pages[0]] : entries[index][1];
    return (reference instanceof WeakRef ? reference.deref() : reference) === value;
  });
}

export function previewSource(projection) {
  if (!projection) return null;
  const signature = previewSignature(projection.document);
  if (signature.length > 1024 || signature.reduce((bytes, [key, value]) => bytes + key.length + (typeof value === 'string' ? value.length : 0), 0) > MAX_PREVIEW_DOCUMENT_BYTES) return null;
  return { pageId: projection.pageId, pages: projection.pages, signature };
}
export function restorePreviewSource(source) {
  if (!source) return null;
  const entries = [];
  for (const [key, reference] of source.signature) {
    const value = reference instanceof WeakRef ? reference.deref() : reference;
    if (reference instanceof WeakRef && value === undefined) return null;
    entries.push([key, value]);
  }
  const document = Object.fromEntries(entries), page = document.pagesById;
  document.pages = [source.pageId]; document.pagesById = { [source.pageId]: page };
  return { pageId: source.pageId, pages: source.pages, document };
}
