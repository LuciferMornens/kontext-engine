import { createHash } from "node:crypto";
import type { ASTNode } from "./parser.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface Chunk {
  id: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  language: string;
  type: "function" | "class" | "method" | "type" | "import" | "constant" | "config";
  name: string | null;
  parent: string | null;
  text: string;
  imports: string[];
  exports: boolean;
  hash: string;
}

export interface ChunkOptions {
  maxTokens?: number;
  overlapLines?: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_TOKENS = 500;
const MERGE_THRESHOLD = 50;
const TOKEN_MULTIPLIER = 1.3;

// ── Token estimation ─────────────────────────────────────────────────────────

export function estimateTokens(text: string): number {
  const wordCount = text.split(/\s+/).filter((w) => w.length > 0).length;
  return Math.ceil(wordCount * TOKEN_MULTIPLIER);
}

// ── Hashing ──────────────────────────────────────────────────────────────────

function makeChunkId(filePath: string, lineStart: number, lineEnd: number): string {
  const input = `${filePath}:${lineStart}:${lineEnd}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function makeContentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// ── Splitting large nodes ────────────────────────────────────────────────────

interface SubChunk {
  lineStart: number;
  lineEnd: number;
  text: string;
}

function splitLargeNode(node: ASTNode, maxTokens: number): SubChunk[] {
  const lines = node.text.split("\n");
  const chunks: SubChunk[] = [];
  let currentLines: string[] = [];
  let currentStartOffset = 0;

  for (let i = 0; i < lines.length; i++) {
    currentLines.push(lines[i]);
    const currentText = currentLines.join("\n");
    const tokens = estimateTokens(currentText);

    if (tokens >= maxTokens && currentLines.length > 1) {
      // Emit what we have so far (excluding the current line)
      currentLines.pop();
      chunks.push({
        lineStart: node.lineStart + currentStartOffset,
        lineEnd: node.lineStart + currentStartOffset + currentLines.length - 1,
        text: currentLines.join("\n"),
      });

      currentStartOffset = i;
      currentLines = [lines[i]];
    }
  }

  // Emit remaining lines
  if (currentLines.length > 0) {
    chunks.push({
      lineStart: node.lineStart + currentStartOffset,
      lineEnd: node.lineStart + currentStartOffset + currentLines.length - 1,
      text: currentLines.join("\n"),
    });
  }

  return chunks;
}

// ── Import grouping ──────────────────────────────────────────────────────────

function groupImports(imports: ASTNode[]): ASTNode | null {
  if (imports.length === 0) return null;

  const sorted = [...imports].sort((a, b) => a.lineStart - b.lineStart);
  return {
    type: "import",
    name: null,
    lineStart: sorted[0].lineStart,
    lineEnd: sorted[sorted.length - 1].lineEnd,
    language: sorted[0].language,
    parent: null,
    text: sorted.map((n) => n.text).join("\n"),
  };
}

// ── Merging small chunks ─────────────────────────────────────────────────────

// Types that are semantically distinct and should never be merged together
const UNMERGEABLE_TYPES = new Set<Chunk["type"]>([
  "function",
  "method",
  "class",
  "type",
  "import",
]);

function canMerge(a: Chunk, b: Chunk): boolean {
  // Never merge semantically distinct node types
  if (UNMERGEABLE_TYPES.has(a.type) || UNMERGEABLE_TYPES.has(b.type)) return false;
  // Only merge chunks of the same type
  if (a.type !== b.type) return false;
  return true;
}

function mergeSmallChunks(chunks: Chunk[], maxTokens: number): Chunk[] {
  if (chunks.length <= 1) return chunks;

  const merged: Chunk[] = [];
  let accumulator: Chunk | null = null;

  for (const chunk of chunks) {
    const chunkTokens = estimateTokens(chunk.text);

    if (accumulator === null) {
      if (chunkTokens < MERGE_THRESHOLD && !UNMERGEABLE_TYPES.has(chunk.type)) {
        accumulator = { ...chunk };
      } else {
        merged.push(chunk);
      }
      continue;
    }

    const accTokens = estimateTokens(accumulator.text);
    const combinedTokens = accTokens + chunkTokens;

    // Merge if both are small, same type, and combined fits
    if (
      chunkTokens < MERGE_THRESHOLD &&
      combinedTokens <= maxTokens &&
      canMerge(accumulator, chunk)
    ) {
      const combinedText = accumulator.text + "\n" + chunk.text;
      accumulator = {
        ...accumulator,
        lineEnd: chunk.lineEnd,
        text: combinedText,
        name: accumulator.name ?? chunk.name,
        id: makeChunkId(accumulator.filePath, accumulator.lineStart, chunk.lineEnd),
        hash: makeContentHash(combinedText),
      };
    } else {
      // Flush accumulator and start fresh
      merged.push(accumulator);
      accumulator =
        chunkTokens < MERGE_THRESHOLD && !UNMERGEABLE_TYPES.has(chunk.type)
          ? { ...chunk }
          : null;
      if (accumulator === null) {
        merged.push(chunk);
      }
    }
  }

  if (accumulator) {
    merged.push(accumulator);
  }

  return merged;
}

// ── Extract import text list for context ─────────────────────────────────────

function collectImportTexts(nodes: ASTNode[]): string[] {
  return nodes.filter((n) => n.type === "import").map((n) => n.text);
}

// ── Main entry point ─────────────────────────────────────────────────────────

export function chunkFile(
  nodes: ASTNode[],
  filePath: string,
  options?: ChunkOptions,
): Chunk[] {
  if (nodes.length === 0) return [];

  const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
  const language = nodes[0].language;
  const importTexts = collectImportTexts(nodes);

  // Sort nodes by line position
  const sorted = [...nodes].sort((a, b) => a.lineStart - b.lineStart);

  // Separate imports from other nodes
  const importNodes = sorted.filter((n) => n.type === "import");
  const nonImportNodes = sorted.filter((n) => n.type !== "import");

  // Track which classes have separate method nodes
  const classesWithMethods = new Set<string>();
  for (const node of nonImportNodes) {
    if (node.type === "method" && node.parent) {
      classesWithMethods.add(node.parent);
    }
  }

  const rawChunks: Chunk[] = [];

  // 1. Group imports into a single chunk
  const groupedImport = groupImports(importNodes);
  if (groupedImport) {
    rawChunks.push({
      id: makeChunkId(filePath, groupedImport.lineStart, groupedImport.lineEnd),
      filePath,
      lineStart: groupedImport.lineStart,
      lineEnd: groupedImport.lineEnd,
      language,
      type: "import",
      name: null,
      parent: null,
      text: groupedImport.text,
      imports: [],
      exports: false,
      hash: makeContentHash(groupedImport.text),
    });
  }

  // 2. Process non-import nodes
  for (const node of nonImportNodes) {
    // Skip class node if it has separate method nodes — methods are chunked individually
    if (node.type === "class" && node.name && classesWithMethods.has(node.name)) {
      continue;
    }

    const tokenCount = estimateTokens(node.text);
    const nodeExports = node.exports ?? false;

    if (tokenCount <= maxTokens) {
      // Single chunk
      rawChunks.push({
        id: makeChunkId(filePath, node.lineStart, node.lineEnd),
        filePath,
        lineStart: node.lineStart,
        lineEnd: node.lineEnd,
        language,
        type: node.type === "export" ? "constant" : node.type,
        name: node.name,
        parent: node.parent,
        text: node.text,
        imports: node.type !== "import" ? importTexts : [],
        exports: nodeExports,
        hash: makeContentHash(node.text),
      });
    } else {
      // Split large node
      const subChunks = splitLargeNode(node, maxTokens);
      for (const sub of subChunks) {
        rawChunks.push({
          id: makeChunkId(filePath, sub.lineStart, sub.lineEnd),
          filePath,
          lineStart: sub.lineStart,
          lineEnd: sub.lineEnd,
          language,
          type: node.type === "export" ? "constant" : node.type,
          name: node.name,
          parent: node.parent,
          text: sub.text,
          imports: importTexts,
          exports: nodeExports,
          hash: makeContentHash(sub.text),
        });
      }
    }
  }

  // 3. Sort by line position
  rawChunks.sort((a, b) => a.lineStart - b.lineStart);

  // 4. Merge very small adjacent chunks
  return mergeSmallChunks(rawChunks, maxTokens);
}
