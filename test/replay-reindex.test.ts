import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerReplayFunctions } from "../src/functions/replay.js";
import { getSearchIndex, setEmbeddingProvider, setVectorIndex } from "../src/functions/search.js";
import { VectorIndex } from "../src/state/vector-index.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, structuredClone(value));
      return value;
    },
    delete: async (scope: string, key: string) => { store.get(scope)?.delete(key); },
    list: async <T>(scope: string): Promise<T[]> => Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

function importer() {
  const fns = new Map<string, Function>();
  const sdk = {
    registerFunction: (id: string, handler: Function) => fns.set(id, handler),
    registerTrigger: () => {},
    trigger: async (input: { function_id: string; payload?: unknown }) => fns.get(input.function_id)?.(input.payload) ?? { success: true },
  };
  registerReplayFunctions(sdk as never, mockKV() as never);
  return (path: string) => fns.get("mem::replay::import-jsonl")!({ path });
}

describe("import-jsonl re-import indexing", () => {
  let root: string;
  let embedded: string[];
  let vectors: VectorIndex;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "replay-reindex-"));
    process.env.AGENTMEMORY_IMPORT_ROOT = root;
    embedded = [];
    vectors = new VectorIndex();
    setVectorIndex(vectors);
    setEmbeddingProvider({
      name: "test",
      dimensions: 2,
      embed: async (text: string) => { embedded.push(text); return new Float32Array([1, 0]); },
      embedBatch: async (texts: string[]) => { embedded.push(...texts); return texts.map(() => new Float32Array([1, 0])); },
    });
  });

  afterEach(() => {
    setVectorIndex(null);
    setEmbeddingProvider(null);
    rmSync(root, { recursive: true, force: true });
  });

  function writeSession(sessionId: string, replies: string[]) {
    const lines = replies.map((text, i) => JSON.stringify({
      type: i % 2 ? "assistant" : "user", uuid: `${sessionId}-${i}`, sessionId, timestamp: "2026-10-30T00:00:00.000Z", cwd: root,
      message: { role: i % 2 ? "assistant" : "user", content: [{ type: "text", text }] },
    }));
    const path = join(root, `${sessionId}.jsonl`);
    writeFileSync(path, lines.join("\n") + "\n");
    return path;
  }

  it("does not embed unchanged observations again", async () => {
    const path = writeSession("reindex-same", ["where is the cobalt config", "in deploy/cobalt.yaml"]);
    const run = importer();
    await run(path);
    const first = embedded.length;
    expect(first).toBe(2);
    await run(path);
    expect(embedded).toHaveLength(first);
    const ids = [...vectors.entries()].map(([id]) => id);
    expect(ids).toHaveLength(2);
    expect(ids.every((id) => getSearchIndex().has(id))).toBe(true);
  });

  it("indexes what is missing from the index or changed since the last import", async () => {
    const path = writeSession("reindex-repair", ["where is the cobalt config", "in deploy/cobalt.yaml"]);
    const run = importer();
    await run(path);
    const [lost] = [...vectors.entries()].map(([id]) => id);
    getSearchIndex().remove(lost);
    vectors.remove(lost);
    embedded = [];
    await run(path);
    expect(embedded).toHaveLength(1);
    expect(getSearchIndex().has(lost) && vectors.has(lost)).toBe(true);

    writeSession("reindex-repair", ["where is the cobalt config", "moved to deploy/cobalt/v2.yaml"]);
    embedded = [];
    await run(path);
    expect(embedded).toHaveLength(1);
    expect(embedded[0]).toContain("v2.yaml");
  });
});
