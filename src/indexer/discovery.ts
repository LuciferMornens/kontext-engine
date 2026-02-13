import type { Dirent, Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import ignore from "ignore";

// ── Types ────────────────────────────────────────────────────────────────────

export interface DiscoveredFile {
  path: string; // relative to project root
  absolutePath: string;
  language: string;
  size: number; // bytes
  lastModified: number; // unix timestamp ms
}

export interface DiscoverOptions {
  root: string;
  extraIgnore?: string[];
  followSymlinks?: boolean; // default true
}

// ── Language extension map ───────────────────────────────────────────────────

export const LANGUAGE_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".kt": "kotlin",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".md": "markdown",
  ".mdx": "markdown",
  ".env": "env",
};

// ── Built-in ignore patterns ─────────────────────────────────────────────────

const BUILTIN_IGNORE = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "*.lock",
  "package-lock.json",
  "*.png",
  "*.jpg",
  "*.jpeg",
  "*.gif",
  "*.webp",
  "*.ico",
  "*.bmp",
  "*.svg",
  "*.woff",
  "*.woff2",
  "*.ttf",
  "*.eot",
  "*.mp3",
  "*.mp4",
  "*.wav",
  "*.avi",
  "*.mov",
  "*.zip",
  "*.tar",
  "*.gz",
  "*.rar",
  "*.7z",
  "*.pdf",
  "*.exe",
  "*.dll",
  "*.so",
  "*.dylib",
  "*.o",
  "*.a",
  "*.wasm",
  "*.pyc",
  "*.class",
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function getLanguage(filePath: string): string | null {
  const basename = path.basename(filePath);

  // Handle dotfiles like .env
  if (basename.startsWith(".") && !basename.includes(".", 1)) {
    const dotExt = basename; // e.g. ".env"
    return LANGUAGE_MAP[dotExt] ?? null;
  }

  const ext = path.extname(filePath).toLowerCase();
  return LANGUAGE_MAP[ext] ?? null;
}

async function readIgnoreFile(filePath: string): Promise<string[]> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  } catch {
    return [];
  }
}

async function statSafe(
  filePath: string,
  followSymlinks: boolean,
): Promise<Stats | null> {
  try {
    return followSymlinks
      ? await fs.stat(filePath)
      : await fs.lstat(filePath);
  } catch {
    return null;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function discoverFiles(
  options: DiscoverOptions,
): Promise<DiscoveredFile[]> {
  const { root, extraIgnore = [], followSymlinks = true } = options;
  const absoluteRoot = path.resolve(root);

  // Build ignore filter
  const ig = ignore();
  ig.add(BUILTIN_IGNORE);

  // Load .gitignore
  const gitignoreRules = await readIgnoreFile(
    path.join(absoluteRoot, ".gitignore"),
  );
  ig.add(gitignoreRules);

  // Load .ctxignore
  const ctxignoreRules = await readIgnoreFile(
    path.join(absoluteRoot, ".ctxignore"),
  );
  ig.add(ctxignoreRules);

  // Add extra ignore patterns
  ig.add(extraIgnore);

  const results: DiscoveredFile[] = [];
  await walkDirectory(absoluteRoot, absoluteRoot, ig, followSymlinks, results);
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

async function walkDirectory(
  dir: string,
  root: string,
  ig: ReturnType<typeof ignore>,
  followSymlinks: boolean,
  results: DiscoveredFile[],
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    // Permission denied or other error — skip silently
    return;
  }

  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);
    const relativePath = path.relative(root, absolutePath);

    // Normalize to forward slashes for ignore matching
    const normalizedRelative = relativePath.split(path.sep).join("/");

    // Check if ignored — directories need trailing slash for ignore
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      const stat = await statSafe(absolutePath, followSymlinks);
      if (!stat) continue;

      if (stat.isDirectory()) {
        if (ig.ignores(normalizedRelative + "/") || ig.ignores(normalizedRelative)) {
          continue;
        }
        await walkDirectory(absolutePath, root, ig, followSymlinks, results);
        continue;
      }

      // Symlink to file — fall through to file handling
      if (!stat.isFile()) continue;
    }

    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    // Check ignore for files
    if (ig.ignores(normalizedRelative)) continue;

    // Get language from extension
    const language = getLanguage(relativePath);
    if (language === null) continue;

    // Stat for metadata
    const stat = await statSafe(absolutePath, followSymlinks);
    if (!stat || !stat.isFile()) continue;

    results.push({
      path: normalizedRelative,
      absolutePath,
      language,
      size: stat.size,
      lastModified: stat.mtimeMs,
    });
  }
}
