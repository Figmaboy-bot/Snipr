import { describe, it, expect } from "vitest";
import { computeImportDelta, chunk } from "./merge.js";

describe("computeImportDelta", () => {
  const existing = {
    saves: [{ id: "s1", label: "Hero" }],
    folders: [{ id: "f-hero", name: "Hero", icon: "🦸" }],
    categories: ["SaaS"],
  };

  it("identifies new saves and skips ones already present by id", () => {
    const incoming = {
      saves: [{ id: "s1", label: "Hero (edited elsewhere)" }, { id: "s2", label: "Footer" }],
    };
    const delta = computeImportDelta(existing, incoming);
    expect(delta.newSaves.map(s => s.id)).toEqual(["s2"]);
    expect(delta.skippedSaves).toBe(1);
  });

  it("is idempotent — importing the same file twice adds nothing the second time", () => {
    const incoming = { saves: [{ id: "s1" }, { id: "s2" }] };
    const first = computeImportDelta(existing, incoming);
    const merged = { ...existing, saves: [...existing.saves, ...first.newSaves] };
    const second = computeImportDelta(merged, incoming);
    expect(second.newSaves).toHaveLength(0);
    expect(second.skippedSaves).toBe(2);
  });

  it("merges new folders by id and new categories by exact string", () => {
    const incoming = {
      folders: [{ id: "f-hero", name: "Hero", icon: "🦸" }, { id: "f-cta", name: "CTA", icon: "📣" }],
      categories: ["SaaS", "Fintech"],
    };
    const delta = computeImportDelta(existing, incoming);
    expect(delta.newFolders.map(f => f.id)).toEqual(["f-cta"]);
    expect(delta.newCategories).toEqual(["Fintech"]);
  });

  it("ignores saves without an id rather than importing them as undefined", () => {
    const incoming = { saves: [{ label: "no id" }, { id: "s2", label: "has id" }] };
    const delta = computeImportDelta(existing, incoming);
    expect(delta.newSaves.map(s => s.id)).toEqual(["s2"]);
  });

  it("handles a completely empty incoming payload without throwing", () => {
    const delta = computeImportDelta(existing, {});
    expect(delta).toEqual({ newSaves: [], skippedSaves: 0, newFolders: [], newCategories: [] });
  });

  it("handles an empty existing vault (first-ever import)", () => {
    const delta = computeImportDelta({ saves: [], folders: [], categories: [] }, {
      saves: [{ id: "s1" }],
      folders: [{ id: "f1" }],
      categories: ["Web3"],
    });
    expect(delta.newSaves).toHaveLength(1);
    expect(delta.newFolders).toHaveLength(1);
    expect(delta.newCategories).toEqual(["Web3"]);
  });
});

describe("chunk", () => {
  it("splits an array into fixed-size slices", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns a single chunk when the array is smaller than the size", () => {
    expect(chunk([1, 2, 3], 400)).toEqual([[1, 2, 3]]);
  });

  it("returns an empty array for an empty input, not [[]]", () => {
    expect(chunk([], 400)).toEqual([]);
  });

  it("handles an exact multiple of the chunk size without a trailing empty chunk", () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
  });
});
