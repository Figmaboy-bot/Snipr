var SniprMerge = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // shared/merge.js
  var merge_exports = {};
  __export(merge_exports, {
    chunk: () => chunk,
    computeImportDelta: () => computeImportDelta
  });
  function computeImportDelta(existing, incoming) {
    const existingSaveIds = new Set((existing.saves || []).map((s) => s.id));
    const incomingSaves = (incoming.saves || []).filter((s) => s && s.id);
    const newSaves = incomingSaves.filter((s) => !existingSaveIds.has(s.id));
    const skippedSaves = incomingSaves.length - newSaves.length;
    const existingFolderIds = new Set((existing.folders || []).map((f) => f.id));
    const newFolders = (incoming.folders || []).filter((f) => f?.id && !existingFolderIds.has(f.id));
    const existingCategorySet = new Set(existing.categories || []);
    const newCategories = (incoming.categories || []).filter((c) => c && !existingCategorySet.has(c));
    return { newSaves, skippedSaves, newFolders, newCategories };
  }
  function chunk(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
    return chunks;
  }
  return __toCommonJS(merge_exports);
})();
self.SniprMerge = SniprMerge;
