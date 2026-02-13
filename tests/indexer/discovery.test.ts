import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { discoverFiles, LANGUAGE_MAP } from "../../src/indexer/discovery.js";

const FIXTURES_ROOT = path.resolve(__dirname, "../fixtures/sample-project");

describe("discoverFiles", () => {
  beforeAll(async () => {
    // Ensure fixture directory exists
    const stat = await fs.stat(FIXTURES_ROOT);
    expect(stat.isDirectory()).toBe(true);
  });

  it("discovers .ts and .js files in a fixture project", async () => {
    const files = await discoverFiles({ root: FIXTURES_ROOT });
    const paths = files.map((f) => f.path);

    expect(paths).toContain("src/auth/middleware.ts");
    expect(paths).toContain("src/auth/login.ts");
    expect(paths).toContain("src/utils/helpers.js");
  });

  it("discovers files of all supported languages", async () => {
    const files = await discoverFiles({ root: FIXTURES_ROOT });
    const languages = new Set(files.map((f) => f.language));

    expect(languages).toContain("typescript");
    expect(languages).toContain("javascript");
    expect(languages).toContain("python");
    expect(languages).toContain("go");
    expect(languages).toContain("json");
    expect(languages).toContain("yaml");
    expect(languages).toContain("toml");
    expect(languages).toContain("markdown");
    expect(languages).toContain("env");
    expect(languages).toContain("rust");
    expect(languages).toContain("java");
    expect(languages).toContain("ruby");
    expect(languages).toContain("php");
    expect(languages).toContain("swift");
    expect(languages).toContain("kotlin");
    expect(languages).toContain("c");
    expect(languages).toContain("cpp");
  });

  it("respects .gitignore patterns", async () => {
    const files = await discoverFiles({ root: FIXTURES_ROOT });
    const paths = files.map((f) => f.path);

    // .gitignore contains: node_modules, dist, *.log
    expect(paths).not.toContain(expect.stringContaining("node_modules/"));
    expect(paths).not.toContain(expect.stringContaining("dist/"));

    // *.log is in .gitignore
    const logFiles = paths.filter((p) => p.endsWith(".log"));
    expect(logFiles).toHaveLength(0);
  });

  it("skips built-in ignore patterns (node_modules, .git, lockfiles, dist, build)", async () => {
    const files = await discoverFiles({ root: FIXTURES_ROOT });
    const paths = files.map((f) => f.path);

    // Built-in: node_modules, .git, lockfiles, build
    const nodeModFiles = paths.filter((p) => p.includes("node_modules"));
    expect(nodeModFiles).toHaveLength(0);

    const buildFiles = paths.filter((p) => p.startsWith("build/"));
    expect(buildFiles).toHaveLength(0);

    const lockFiles = paths.filter(
      (p) => p.endsWith(".lock") || p === "package-lock.json",
    );
    expect(lockFiles).toHaveLength(0);
  });

  it("respects .ctxignore custom patterns", async () => {
    // Create a temporary .ctxignore
    const ctxignorePath = path.join(FIXTURES_ROOT, ".ctxignore");
    await fs.writeFile(ctxignorePath, "docs\n*.env\n", "utf-8");

    try {
      const files = await discoverFiles({ root: FIXTURES_ROOT });
      const paths = files.map((f) => f.path);

      const docFiles = paths.filter((p) => p.startsWith("docs/"));
      expect(docFiles).toHaveLength(0);

      const envFiles = paths.filter((p) => p.endsWith(".env"));
      expect(envFiles).toHaveLength(0);
    } finally {
      await fs.unlink(ctxignorePath);
    }
  });

  it("skips binary files", async () => {
    const files = await discoverFiles({ root: FIXTURES_ROOT });
    const paths = files.map((f) => f.path);

    const pngFiles = paths.filter((p) => p.endsWith(".png"));
    expect(pngFiles).toHaveLength(0);
  });

  it("correctly maps extensions to languages", async () => {
    const files = await discoverFiles({ root: FIXTURES_ROOT });
    const byPath = new Map(files.map((f) => [f.path, f]));

    expect(byPath.get("src/auth/middleware.ts")?.language).toBe("typescript");
    expect(byPath.get("src/main.tsx")?.language).toBe("typescript");
    expect(byPath.get("src/utils/helpers.js")?.language).toBe("javascript");
    expect(byPath.get("src/utils/format.jsx")?.language).toBe("javascript");
    expect(byPath.get("src/db/schema.py")?.language).toBe("python");
    expect(byPath.get("src/db/connection.go")?.language).toBe("go");
    expect(byPath.get("config/database.json")?.language).toBe("json");
    expect(byPath.get("config/app.yaml")?.language).toBe("yaml");
    expect(byPath.get("config/settings.toml")?.language).toBe("toml");
    expect(byPath.get("docs/README.md")?.language).toBe("markdown");
    expect(byPath.get("src/lib.rs")?.language).toBe("rust");
    expect(byPath.get("src/Main.java")?.language).toBe("java");
    expect(byPath.get("src/app.rb")?.language).toBe("ruby");
    expect(byPath.get("src/index.php")?.language).toBe("php");
    expect(byPath.get("src/app.swift")?.language).toBe("swift");
    expect(byPath.get("src/Main.kt")?.language).toBe("kotlin");
    expect(byPath.get("src/utils.c")?.language).toBe("c");
    expect(byPath.get("src/utils.h")?.language).toBe("c");
    expect(byPath.get("src/engine.cpp")?.language).toBe("cpp");
    expect(byPath.get("src/engine.hpp")?.language).toBe("cpp");
  });

  it("handles nested directories", async () => {
    const files = await discoverFiles({ root: FIXTURES_ROOT });
    const paths = files.map((f) => f.path);

    // Files deep in nested dirs
    expect(paths).toContain("src/auth/middleware.ts");
    expect(paths).toContain("src/auth/login.ts");
    expect(paths).toContain("src/db/schema.py");
    expect(paths).toContain("src/db/connection.go");
  });

  it("handles empty directories gracefully", async () => {
    const emptyDir = path.join(FIXTURES_ROOT, "empty-dir");
    await fs.mkdir(emptyDir, { recursive: true });

    // Should not throw
    const files = await discoverFiles({ root: FIXTURES_ROOT });
    expect(files.length).toBeGreaterThan(0);
  });

  it("supports extraIgnore option", async () => {
    const files = await discoverFiles({
      root: FIXTURES_ROOT,
      extraIgnore: ["src/auth/**"],
    });
    const paths = files.map((f) => f.path);

    expect(paths).not.toContain("src/auth/middleware.ts");
    expect(paths).not.toContain("src/auth/login.ts");
    // Other files should still be present
    expect(paths).toContain("src/utils/helpers.js");
  });

  it("returns correct file metadata (path, absolutePath, size, lastModified)", async () => {
    const files = await discoverFiles({ root: FIXTURES_ROOT });
    const middleware = files.find((f) => f.path === "src/auth/middleware.ts");

    expect(middleware).toBeDefined();
    if (!middleware) return; // guard for TS — toBeDefined already asserts
    expect(middleware.absolutePath).toBe(
      path.join(FIXTURES_ROOT, "src/auth/middleware.ts"),
    );
    expect(middleware.size).toBeGreaterThan(0);
    expect(middleware.lastModified).toBeGreaterThan(0);
    expect(typeof middleware.lastModified).toBe("number");
  });

  it("returns paths relative to project root", async () => {
    const files = await discoverFiles({ root: FIXTURES_ROOT });

    for (const file of files) {
      expect(path.isAbsolute(file.path)).toBe(false);
      expect(file.path.startsWith("/")).toBe(false);
      expect(file.path).not.toContain("\\"); // no backslashes
    }
  });

  it("handles permission errors gracefully", async () => {
    // Create a file, then make its parent unreadable
    const restrictedDir = path.join(FIXTURES_ROOT, "restricted");
    const restrictedFile = path.join(restrictedDir, "secret.ts");
    await fs.mkdir(restrictedDir, { recursive: true });
    await fs.writeFile(restrictedFile, "export const secret = 42;", "utf-8");
    await fs.chmod(restrictedDir, 0o000);

    try {
      // Should not throw — just skip the restricted directory
      const files = await discoverFiles({ root: FIXTURES_ROOT });
      const paths = files.map((f) => f.path);
      expect(paths).not.toContain("restricted/secret.ts");
    } finally {
      // Restore permissions for cleanup
      await fs.chmod(restrictedDir, 0o755);
      await fs.rm(restrictedDir, { recursive: true });
    }
  });
});

describe("LANGUAGE_MAP", () => {
  it("maps all required extensions", () => {
    expect(LANGUAGE_MAP[".ts"]).toBe("typescript");
    expect(LANGUAGE_MAP[".tsx"]).toBe("typescript");
    expect(LANGUAGE_MAP[".js"]).toBe("javascript");
    expect(LANGUAGE_MAP[".jsx"]).toBe("javascript");
    expect(LANGUAGE_MAP[".py"]).toBe("python");
    expect(LANGUAGE_MAP[".go"]).toBe("go");
    expect(LANGUAGE_MAP[".rs"]).toBe("rust");
    expect(LANGUAGE_MAP[".java"]).toBe("java");
    expect(LANGUAGE_MAP[".rb"]).toBe("ruby");
    expect(LANGUAGE_MAP[".php"]).toBe("php");
    expect(LANGUAGE_MAP[".swift"]).toBe("swift");
    expect(LANGUAGE_MAP[".kt"]).toBe("kotlin");
    expect(LANGUAGE_MAP[".c"]).toBe("c");
    expect(LANGUAGE_MAP[".h"]).toBe("c");
    expect(LANGUAGE_MAP[".cpp"]).toBe("cpp");
    expect(LANGUAGE_MAP[".hpp"]).toBe("cpp");
    expect(LANGUAGE_MAP[".json"]).toBe("json");
    expect(LANGUAGE_MAP[".yaml"]).toBe("yaml");
    expect(LANGUAGE_MAP[".yml"]).toBe("yaml");
    expect(LANGUAGE_MAP[".toml"]).toBe("toml");
    expect(LANGUAGE_MAP[".md"]).toBe("markdown");
    expect(LANGUAGE_MAP[".env"]).toBe("env");
  });
});
