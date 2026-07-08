// Pure merge/batching helpers shared by the extension's background.js
// (via shared/merge.bundle.js + importScripts) and the webapp (imported
// directly, since it's already ESM/esbuild-bundled). No DOM, no Firebase,
// no Chrome APIs — safe to run in a service worker, a browser tab, or a
// test runner, which is the whole point: this is the logic that decides
// what an "import" actually writes, so it needs to be right.

// Given the vault currently in place and an incoming (imported/shared) one,
// works out what's actually new. Saves and folders are matched by id so
// re-importing the same file twice is a no-op rather than creating
// duplicates; categories are matched by exact string.
export function computeImportDelta(existing, incoming) {
  const existingSaveIds = new Set((existing.saves || []).map(s => s.id));
  const incomingSaves = (incoming.saves || []).filter(s => s && s.id);
  const newSaves = incomingSaves.filter(s => !existingSaveIds.has(s.id));
  const skippedSaves = incomingSaves.length - newSaves.length;

  const existingFolderIds = new Set((existing.folders || []).map(f => f.id));
  const newFolders = (incoming.folders || []).filter(f => f?.id && !existingFolderIds.has(f.id));

  const existingCategorySet = new Set(existing.categories || []);
  const newCategories = (incoming.categories || []).filter(c => c && !existingCategorySet.has(c));

  return { newSaves, skippedSaves, newFolders, newCategories };
}

// Splits an array into fixed-size slices — used to stay under Firestore's
// 500-operation batch-write limit when creating/deleting many docs at once.
export function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
  return chunks;
}
