import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const DIST = path.join(ROOT, "dist");

describe("package build", () => {
  beforeAll(() => {
    execSync("npm run build", { cwd: ROOT, stdio: "pipe" });
  }, 60_000);

  it("build produces dist/cli/index.js", () => {
    expect(fs.existsSync(path.join(DIST, "cli/index.js"))).toBe(true);
  });

  it("build produces dist/index.js (library entry)", () => {
    expect(fs.existsSync(path.join(DIST, "index.js"))).toBe(true);
  });

  it("CLI entry has shebang", () => {
    const content = fs.readFileSync(path.join(DIST, "cli/index.js"), "utf-8");
    expect(content.startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("library entry does NOT have shebang", () => {
    const content = fs.readFileSync(path.join(DIST, "index.js"), "utf-8");
    expect(content.startsWith("#!/")).toBe(false);
  });

  it("CLI --help outputs help text", () => {
    const output = execSync("node dist/cli/index.js --help", {
      cwd: ROOT,
      encoding: "utf-8",
    });
    expect(output).toContain("ctx");
    expect(output).toContain("init");
    expect(output).toContain("query");
    expect(output).toContain("ask");
    expect(output).toContain("watch");
    expect(output).toContain("status");
    expect(output).toContain("config");
  });

  it("find command uses query command options (alias)", () => {
    const output = execSync("node dist/cli/index.js find --help", {
      cwd: ROOT,
      encoding: "utf-8",
    });
    expect(output).toContain("Multi-strategy code search");
    expect(output).toContain("--strategy");
    expect(output).toContain("--no-vectors");
    expect(output).toContain("--format");
    expect(output).not.toContain("--no-llm");
    expect(output).not.toContain("--full");
  });

  it("CLI --version outputs version", () => {
    const output = execSync("node dist/cli/index.js --version", {
      cwd: ROOT,
      encoding: "utf-8",
    });
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8")) as {
      version?: string;
    };
    expect(output.trim()).toBe(pkg.version);
  });

  it("npm pack creates tarball", () => {
    const output = execSync("npm pack --dry-run 2>&1", {
      cwd: ROOT,
      encoding: "utf-8",
    });
    expect(output).toContain("kontext-");
    expect(output).toContain("dist/cli/index.js");
    expect(output).toContain("dist/index.js");
    expect(output).toContain("README.md");
    expect(output).toContain("LICENSE");
  });

  it("library entry exports key functions", async () => {
    const lib = await import("../../src/index.js");

    // Functions
    expect(typeof lib.discoverFiles).toBe("function");
    expect(typeof lib.parseFile).toBe("function");
    expect(typeof lib.initParser).toBe("function");
    expect(typeof lib.chunkFile).toBe("function");
    expect(typeof lib.createLocalEmbedder).toBe("function");
    expect(typeof lib.createVoyageEmbedder).toBe("function");
    expect(typeof lib.createOpenAIEmbedder).toBe("function");
    expect(typeof lib.createDatabase).toBe("function");
    expect(typeof lib.vectorSearch).toBe("function");
    expect(typeof lib.ftsSearch).toBe("function");
    expect(typeof lib.astSearch).toBe("function");
    expect(typeof lib.pathSearch).toBe("function");
    expect(typeof lib.dependencyTrace).toBe("function");
    expect(typeof lib.fusionMerge).toBe("function");
    expect(typeof lib.runInit).toBe("function");
  });
});
