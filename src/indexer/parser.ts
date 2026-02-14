import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import Parser from "web-tree-sitter";

// ── Types ────────────────────────────────────────────────────────────────────

/** An extracted AST node: function, class, method, type, import, or constant. */
export interface ASTNode {
  type: "function" | "class" | "method" | "import" | "export" | "type" | "constant";
  name: string | null;
  lineStart: number;
  lineEnd: number;
  language: string;
  parent: string | null;
  params?: string[];
  returnType?: string;
  docstring?: string;
  imports?: string[];
  exports?: boolean;
  text: string;
}

// ── Language grammar mapping ─────────────────────────────────────────────────

const GRAMMAR_FILES: Record<string, string> = {
  typescript: "tree-sitter-typescript.wasm",
  javascript: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
};

// ── Parser cache ─────────────────────────────────────────────────────────────

const require = createRequire(import.meta.url);
let initialized = false;
const languageCache = new Map<string, Parser.Language>();

function resolveWasmPath(filename: string): string {
  if (filename === "tree-sitter.wasm") {
    return path.join(path.dirname(require.resolve("web-tree-sitter")), filename);
  }
  return path.join(path.dirname(require.resolve("tree-sitter-wasms/package.json")), "out", filename);
}

/** Initialize the Tree-sitter WebAssembly parser. Must be called before parseFile. */
export async function initParser(): Promise<void> {
  if (initialized) return;
  await Parser.init({
    locateFile: (scriptName: string) => resolveWasmPath(scriptName),
  });
  initialized = true;
}

async function getLanguage(language: string): Promise<Parser.Language | null> {
  const grammarFile = GRAMMAR_FILES[language];
  if (!grammarFile) return null;

  const cached = languageCache.get(language);
  if (cached) return cached;

  const wasmPath = resolveWasmPath(grammarFile);
  const lang = await Parser.Language.load(wasmPath);
  languageCache.set(language, lang);
  return lang;
}

// ── Docstring extraction ─────────────────────────────────────────────────────

function extractDocstring(
  node: Parser.SyntaxNode,
  language: string,
): string | undefined {
  if (language === "python") {
    // Python docstrings: first child expression_statement containing a string
    const body = node.childForFieldName("body");
    if (body) {
      const firstStmt = body.namedChildren[0];
      if (firstStmt?.type === "expression_statement") {
        const strNode = firstStmt.namedChildren[0];
        if (strNode?.type === "string") {
          // Strip surrounding quotes (""" or ')
          const raw = strNode.text;
          return raw.replace(/^["']{1,3}|["']{1,3}$/g, "").trim();
        }
      }
    }
    return undefined;
  }

  // JS/TS: look for a comment preceding the node
  const prev = findPrecedingComment(node);
  if (prev) return cleanJSDocComment(prev.text);
  return undefined;
}

function findPrecedingComment(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  // Walk backward through previous siblings
  let candidate: Parser.SyntaxNode | null = node.previousNamedSibling;

  // If this node is wrapped in export_statement, check before the export
  if (node.parent?.type === "export_statement") {
    candidate = node.parent.previousNamedSibling;
  }

  if (candidate?.type === "comment") return candidate;
  return null;
}

function cleanJSDocComment(text: string): string {
  return text
    .replace(/^\/\*\*?\s*/, "")
    .replace(/\s*\*\/$/, "")
    .replace(/^\s*\* ?/gm, "")
    .trim();
}

// ── Parameter extraction ─────────────────────────────────────────────────────

function extractParams(
  node: Parser.SyntaxNode,
  language: string,
): string[] | undefined {
  const paramsNode =
    node.childForFieldName("parameters") ??
    node.childForFieldName("formal_parameters");

  if (!paramsNode) return undefined;

  if (language === "python") {
    return paramsNode.namedChildren
      .filter((c) => c.type !== "comment")
      .map((c) => c.text)
      .filter((t) => t !== "self" && t !== "cls");
  }

  // JS/TS
  return paramsNode.namedChildren
    .filter((c) => c.type !== "comment")
    .map((c) => c.text);
}

function extractReturnType(
  node: Parser.SyntaxNode,
  language: string,
): string | undefined {
  if (language === "python") {
    const retType = node.childForFieldName("return_type");
    return retType?.text;
  }

  // TS: return type annotation comes after parameters
  const retType = node.childForFieldName("return_type");
  if (retType) {
    // Strip leading ": " from the type annotation
    const text = retType.text;
    return text.startsWith(":") ? text.slice(1).trim() : text;
  }
  return undefined;
}

// ── Node extraction per language ─────────────────────────────────────────────

function isExported(node: Parser.SyntaxNode): boolean {
  return node.parent?.type === "export_statement";
}

function extractTopLevelNode(node: Parser.SyntaxNode): Parser.SyntaxNode {
  // If wrapped in export_statement, return the export_statement for text/range
  if (node.parent?.type === "export_statement") return node.parent;
  return node;
}

function extractTypeScript(
  rootNode: Parser.SyntaxNode,
  source: string,
  language: string,
): ASTNode[] {
  const nodes: ASTNode[] = [];

  function walk(node: Parser.SyntaxNode, parentClassName: string | null): void {
    for (const child of node.namedChildren) {
      // Unwrap export_statement to get the inner declaration
      const inner =
        child.type === "export_statement"
          ? (child.namedChildren.find(
              (c) =>
                c.type === "function_declaration" ||
                c.type === "class_declaration" ||
                c.type === "lexical_declaration" ||
                c.type === "interface_declaration" ||
                c.type === "type_alias_declaration" ||
                c.type === "abstract_class_declaration",
            ) ?? child)
          : child;

      switch (inner.type) {
        case "import_statement": {
          nodes.push({
            type: "import",
            name: null,
            lineStart: inner.startPosition.row + 1,
            lineEnd: inner.endPosition.row + 1,
            language,
            parent: null,
            text: inner.text,
          });
          break;
        }

        case "function_declaration": {
          const topNode = extractTopLevelNode(inner);
          const name = inner.childForFieldName("name")?.text ?? null;
          nodes.push({
            type: parentClassName ? "method" : "function",
            name,
            lineStart: topNode.startPosition.row + 1,
            lineEnd: topNode.endPosition.row + 1,
            language,
            parent: parentClassName,
            params: extractParams(inner, language),
            returnType: extractReturnType(inner, language),
            docstring: extractDocstring(inner, language),
            exports: isExported(inner),
            text: topNode.text,
          });
          break;
        }

        case "class_declaration":
        case "abstract_class_declaration": {
          const topNode = extractTopLevelNode(inner);
          const className = inner.childForFieldName("name")?.text ?? null;
          nodes.push({
            type: "class",
            name: className,
            lineStart: topNode.startPosition.row + 1,
            lineEnd: topNode.endPosition.row + 1,
            language,
            parent: null,
            docstring: extractDocstring(inner, language),
            exports: isExported(inner),
            text: topNode.text,
          });

          // Extract methods from class body
          const classBody = inner.childForFieldName("body");
          if (classBody) {
            for (const member of classBody.namedChildren) {
              if (member.type === "method_definition") {
                const methodName = member.childForFieldName("name")?.text ?? null;
                nodes.push({
                  type: "method",
                  name: methodName,
                  lineStart: member.startPosition.row + 1,
                  lineEnd: member.endPosition.row + 1,
                  language,
                  parent: className,
                  params: extractParams(member, language),
                  returnType: extractReturnType(member, language),
                  docstring: extractDocstring(member, language),
                  exports: isExported(inner),
                  text: member.text,
                });
              }
            }
          }
          break;
        }

        case "interface_declaration": {
          const topNode = extractTopLevelNode(inner);
          const name = inner.childForFieldName("name")?.text ?? null;
          nodes.push({
            type: "type",
            name,
            lineStart: topNode.startPosition.row + 1,
            lineEnd: topNode.endPosition.row + 1,
            language,
            parent: null,
            docstring: extractDocstring(inner, language),
            exports: isExported(inner),
            text: topNode.text,
          });
          break;
        }

        case "type_alias_declaration": {
          const topNode = extractTopLevelNode(inner);
          const name = inner.childForFieldName("name")?.text ?? null;
          nodes.push({
            type: "type",
            name,
            lineStart: topNode.startPosition.row + 1,
            lineEnd: topNode.endPosition.row + 1,
            language,
            parent: null,
            docstring: extractDocstring(inner, language),
            exports: isExported(inner),
            text: topNode.text,
          });
          break;
        }

        case "lexical_declaration": {
          const topNode = extractTopLevelNode(inner);
          // Extract variable name from declarators
          const declarator = inner.namedChildren.find(
            (c) => c.type === "variable_declarator",
          );
          const name = declarator?.childForFieldName("name")?.text ?? null;
          nodes.push({
            type: "constant",
            name,
            lineStart: topNode.startPosition.row + 1,
            lineEnd: topNode.endPosition.row + 1,
            language,
            parent: parentClassName,
            docstring: extractDocstring(inner, language),
            exports: isExported(inner),
            text: topNode.text,
          });
          break;
        }

        default:
          // Recurse into other node types but don't handle unrecognized export_statement children
          if (child.type !== "export_statement") {
            // Don't recurse further for non-export top-level
          }
          break;
      }
    }
  }

  walk(rootNode, null);
  return nodes;
}

function extractPython(
  rootNode: Parser.SyntaxNode,
  _source: string,
  language: string,
): ASTNode[] {
  const nodes: ASTNode[] = [];

  function walk(node: Parser.SyntaxNode, parentClassName: string | null): void {
    for (const child of node.namedChildren) {
      switch (child.type) {
        case "import_statement":
        case "import_from_statement": {
          nodes.push({
            type: "import",
            name: null,
            lineStart: child.startPosition.row + 1,
            lineEnd: child.endPosition.row + 1,
            language,
            parent: null,
            text: child.text,
          });
          break;
        }

        case "function_definition": {
          const name = child.childForFieldName("name")?.text ?? null;
          nodes.push({
            type: parentClassName ? "method" : "function",
            name,
            lineStart: child.startPosition.row + 1,
            lineEnd: child.endPosition.row + 1,
            language,
            parent: parentClassName,
            params: extractParams(child, language),
            returnType: extractReturnType(child, language),
            docstring: extractDocstring(child, language),
            text: child.text,
          });
          break;
        }

        case "decorated_definition": {
          // Unwrap decorated definition to get the inner function/class
          const innerDef = child.namedChildren.find(
            (c) =>
              c.type === "function_definition" || c.type === "class_definition",
          );
          if (innerDef) {
            // Process as if it were the inner node, but use the decorated range
            const name = innerDef.childForFieldName("name")?.text ?? null;

            if (innerDef.type === "function_definition") {
              nodes.push({
                type: parentClassName ? "method" : "function",
                name,
                lineStart: child.startPosition.row + 1,
                lineEnd: child.endPosition.row + 1,
                language,
                parent: parentClassName,
                params: extractParams(innerDef, language),
                returnType: extractReturnType(innerDef, language),
                docstring: extractDocstring(innerDef, language),
                text: child.text,
              });
            } else if (innerDef.type === "class_definition") {
              nodes.push({
                type: "class",
                name,
                lineStart: child.startPosition.row + 1,
                lineEnd: child.endPosition.row + 1,
                language,
                parent: null,
                docstring: extractDocstring(innerDef, language),
                text: child.text,
              });

              // Extract methods from class body
              const body = innerDef.childForFieldName("body");
              if (body) walk(body, name);
            }
          }
          break;
        }

        case "class_definition": {
          const name = child.childForFieldName("name")?.text ?? null;
          nodes.push({
            type: "class",
            name,
            lineStart: child.startPosition.row + 1,
            lineEnd: child.endPosition.row + 1,
            language,
            parent: null,
            docstring: extractDocstring(child, language),
            text: child.text,
          });

          // Extract methods from class body
          const body = child.childForFieldName("body");
          if (body) walk(body, name);
          break;
        }

        case "expression_statement": {
          // Top-level assignments → constants
          const assignment = child.namedChildren.find(
            (c) => c.type === "assignment",
          );
          if (assignment && parentClassName === null) {
            const left = assignment.childForFieldName("left");
            if (left?.type === "identifier") {
              nodes.push({
                type: "constant",
                name: left.text,
                lineStart: child.startPosition.row + 1,
                lineEnd: child.endPosition.row + 1,
                language,
                parent: null,
                text: child.text,
              });
            }
          }
          break;
        }

        default:
          break;
      }
    }
  }

  walk(rootNode, null);
  return nodes;
}

// ── Main entry point ─────────────────────────────────────────────────────────

/** Parse a source file with Tree-sitter and extract AST nodes. */
export async function parseFile(
  filePath: string,
  language: string,
): Promise<ASTNode[]> {
  await initParser();

  const lang = await getLanguage(language);
  if (!lang) return [];

  let source: string;
  try {
    source = await fs.readFile(filePath, "utf-8");
  } catch {
    return [];
  }

  const parser = new Parser();
  parser.setLanguage(lang);

  const tree = parser.parse(source);
  if (!tree) return [];

  try {
    if (language === "python") {
      return extractPython(tree.rootNode, source, language);
    }
    // TypeScript and JavaScript share the same extraction logic
    return extractTypeScript(tree.rootNode, source, language);
  } finally {
    tree.delete();
    parser.delete();
  }
}
