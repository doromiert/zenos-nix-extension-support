import * as vscode from "vscode";
import * as cp from "child_process";

let diagnosticTimeout: NodeJS.Timeout | undefined = undefined;

export function activate(context: vscode.ExtensionContext) {
  const zenSelector = { scheme: "file", language: "zen-nix" };

  const completionProvider = vscode.languages.registerCompletionItemProvider(
    zenSelector,
    {
      provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
      ) {
        const completions: vscode.CompletionItem[] = [];
        const linePrefix = document.lineAt(position).text;

        // Helper to explicitly calculate the overwrite range, bypassing VS Code's word engine
        const createItemWithRange = (
          label: string,
          kind: vscode.CompletionItemKind,
          insert: string,
          detail: string,
          matchText: string,
        ) => {
          const item = new vscode.CompletionItem(label, kind);
          item.insertText = new vscode.SnippetString(insert);
          item.detail = detail;

          const startPos = position.character - matchText.length;
          item.range = new vscode.Range(
            position.line,
            Math.max(0, startPos),
            position.line,
            position.character,
          );

          return item;
        };

        // 1. $type. Context
        const typeMatch = linePrefix.match(/\$type\.[a-zA-Z0-9_-]*$/);
        if (typeMatch) {
          [
            "boolean",
            "bool",
            "string",
            "int",
            "float",
            "null",
            "set",
            "list",
            "path",
            "package",
            "packages",
            "color",
            "function",
            "functionTo",
            "enum",
            "either",
          ].forEach((type) => {
            completions.push(
              createItemWithRange(
                `$type.${type}`,
                vscode.CompletionItemKind.EnumMember,
                type,
                `ZenOS Type: ${type}`,
                typeMatch[0],
              ),
            );
          });
        }

        // 2. Global Variables Context ($)
        const globalVarMatch = linePrefix.match(/\$[a-zA-Z0-9_-]*$/);
        if (globalVarMatch && !typeMatch) {
          [
            { label: "type", detail: "The ZenOS Type System" },
            { label: "cfg", detail: "Global Evaluated Configuration" },
            { label: "pkgs", detail: "ZenPkgs (Packages Only)" },
            { label: "path", detail: "Nix-path to current module" },
            { label: "name", detail: "Name of current node" },
            { label: "v", detail: "Access _let variables" },
            { label: "f", detail: "Access freeform identifiers" },
            { label: "c", detail: "Color primitives" },
            { label: "lib", detail: "Nixpkgs library" },
            { label: "l", detail: "Licenses" },
            { label: "m", detail: "Maintainers" },
            { label: "deps", detail: "Runtime deps (resolved store paths) — .zpkg only" },
          ].forEach((v) => {
            completions.push(
              createItemWithRange(
                `$${v.label}`,
                vscode.CompletionItemKind.Variable,
                v.label,
                v.detail,
                globalVarMatch[0],
              ),
            );
          });
        }

        // 3. Keywords & Metadata (_)
        const keywordMatch = linePrefix.match(/_[a-zA-Z0-9_-]*$/);
        if (keywordMatch) {
          [
            { label: "meta", detail: "Module Metadata block" },
            { label: "let", detail: "Internal typed variable" },
            { label: "import", detail: "Import another ZenOS file" },
            { label: "src", detail: ".zpkg source fetcher block" },
            { label: "build", detail: ".zpkg build configuration" },
          ].forEach((kw) => {
            let snippetBody: string;
            if (kw.label === "let") {
              snippetBody = `_let $0`;
            } else if (kw.label === "meta") {
              const metaFields = ["brief", "description", "dependencies", "version", "maintainers", "license"]
                .map((v) =>
                  v === "maintainers" || v === "dependencies"
                    ? `\t${v} = [];\n`
                    : `\t${v} = "";\n`,
                )
                .join("");
              snippetBody = `_meta = {\n${metaFields}$0\n};`;
            } else if (kw.label === "import") {
              snippetBody = `_import "\${1:path}"`;
            } else if (kw.label === "src") {
              snippetBody = `_src = src.\${1|github,tarball,git,url|} {\n\towner = "\${2:owner}";\n\trepo  = "\${3:repo}";\n\trev   = "\${4:rev}";\n\thash  = "sha256-\${5:...}";\n};`;
            } else if (kw.label === "build") {
              snippetBody = `_build = {\n\ttype = \\$type.\${1|stdenv,cargo|};\n\t$0\n};`;
            } else {
              snippetBody = `_${kw.label} = {\n\t$0\n};`;
            }
            completions.push(
              createItemWithRange(
                `_${kw.label}`,
                vscode.CompletionItemKind.Keyword,
                snippetBody,
                kw.detail,
                keywordMatch[0],
              ),
            );
          });
        }

        // 4. Action Shorthands — all six forms (!! before ! to avoid ambiguity)
        const shorthandMatch = linePrefix.match(/(?:^|\s)(s!!|u!!|s!|u!|!!|!)$/);
        const isBlankLine = linePrefix.trim().length === 0;

        if (shorthandMatch || isBlankLine) {
          const matchText = shorthandMatch ? shorthandMatch[1] : "";
          [
            { label: "!",   insert: "!",   detail: "Conditional action (generic)" },
            { label: "!!",  insert: "!!",  detail: "Unconditional action (generic)" },
            { label: "s!",  insert: "s!",  detail: "Conditional system action" },
            { label: "s!!", insert: "s!!", detail: "Unconditional system action" },
            { label: "u!",  insert: "u!",  detail: "Conditional user/HM action" },
            { label: "u!!", insert: "u!!", detail: "Unconditional user/HM action" },
          ].forEach((sh) => {
            if (matchText && !sh.label.startsWith(matchText)) return;

            completions.push(
              createItemWithRange(
                sh.label,
                vscode.CompletionItemKind.Snippet,
                `${sh.insert} {\n\t$0\n};`,
                sh.detail,
                matchText || "",
              ),
            );
          });
        }

        // 5. enableOption sugar (triggered when typing "enable...")
        const enableMatch = linePrefix.match(/(?:^|\s)(enable[a-zA-Z0-9_-]*)$/);
        if (enableMatch) {
          completions.push(
            createItemWithRange(
              "enableOption",
              vscode.CompletionItemKind.Function,
              `enableOption {\n\t_meta.brief = "\${1:Install \\\$name}";\n\n\ts! {\n\t\t$0\n\t};\n}`,
              "ZenOS: Standard boolean enable option sugar",
              enableMatch[1],
            ),
          );
        }

        // 6. Structural node completions — triggered after '('
        const structMatch = linePrefix.match(/\(\s*([a-zA-Z0-9_-]*)$/);
        if (structMatch) {
          const prefix = structMatch[1];
          [
            { type: "freeform",  snippet: `freeform \${1:id})`,   detail: "Open attr set with dynamic key name" },
            { type: "zmdl",     snippet: `zmdl \${1:name})`,      detail: "Attach a .zmdl module" },
            { type: "alias",    snippet: `alias \${1:path})`,     detail: "Alias to another config path" },
            { type: "programs", snippet: `programs)`,             detail: "Programs namespace scope" },
            { type: "packages", snippet: `packages)`,             detail: "Packages namespace scope" },
          ].forEach(({ type, snippet, detail }) => {
            if (prefix && !type.startsWith(prefix)) return;
            completions.push(
              createItemWithRange(
                `(${type})`,
                vscode.CompletionItemKind.Keyword,
                snippet,
                `ZenOS structural node — ${detail}`,
                structMatch[0],
              ),
            );
          });
        }

        return completions;
      },
    },
  );

  const diagnosticCollection =
    vscode.languages.createDiagnosticCollection("zen-nix");

  vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.document.languageId === "zen-nix") {
      scheduleDiagnostics(event.document, diagnosticCollection);
    }
  });

  if (
    vscode.window.activeTextEditor &&
    vscode.window.activeTextEditor.document.languageId === "zen-nix"
  ) {
    scheduleDiagnostics(
      vscode.window.activeTextEditor.document,
      diagnosticCollection,
    );
  }

  context.subscriptions.push(completionProvider, diagnosticCollection);

  // --- 3. Document Formatting Provider ---
  const formattingProvider =
    vscode.languages.registerDocumentFormattingEditProvider(zenSelector, {
      provideDocumentFormattingEdits(
        document: vscode.TextDocument,
      ): vscode.ProviderResult<vscode.TextEdit[]> {
        const originalText = document.getText();
        if (!originalText.trim()) return [];

        // --- MASKING: Convert custom Z.O.N.E. syntax into valid Nix for nixfmt ---
        let maskedText = originalText;

        // Mask _import lines entirely (stored for restore after format)
        const importLines: string[] = [];
        maskedText = maskedText.replace(
          /^(\s*)_import\b.*$/gm,
          (match, indent) => {
            importLines.push(match.trim());
            return `${indent}__Z_IMPORT_${importLines.length - 1}__ = null`;
          },
        );

        // Mask dep cascade operators ++[...] and --[...] (single-line)
        const addOps: string[] = [];
        maskedText = maskedText.replace(/\+\+\[[^\]]*\]/g, (match) => {
          addOps.push(match);
          return `__Z_ADDOP_${addOps.length - 1}__`;
        });
        const subOps: string[] = [];
        maskedText = maskedText.replace(/--\[[^\]]*\]/g, (match) => {
          subOps.push(match);
          return `__Z_SUBOP_${subOps.length - 1}__`;
        });

        // Mask Path Interpolations `($var.name)` -> `__Z_PATH_VAR_0__` to prevent `.` parser crashes in nixfmt
        const pathVars: string[] = [];
        maskedText = maskedText.replace(
          /\(\s*\$([a-zA-Z0-9_.-]+)\s*\)/g,
          (match, p1) => {
            pathVars.push(p1);
            return `__Z_PATH_VAR_${pathVars.length - 1}__`;
          },
        );

        // Mask $ variables -> __Z_DOL__
        maskedText = maskedText.replace(/\$/g, "__Z_DOL__");

        // Mask unconditional actions BEFORE their conditional counterparts
        maskedText = maskedText.replace(
          /(^|\s)s!!\s*=?\s*\{/gm,
          "$1__Z_SUBBANG__ = {",
        );
        maskedText = maskedText.replace(
          /(^|\s)u!!\s*=?\s*\{/gm,
          "$1__Z_UUBBANG__ = {",
        );
        maskedText = maskedText.replace(
          /(^|\s)!!\s*=?\s*\{/gm,
          "$1__Z_DBBANG__ = {",
        );

        // Mask Conditional Action Shorthands -> __Z_*BANG__ =
        maskedText = maskedText.replace(
          /(^|\s)s!\s*=?\s*(\[.*?\]\s*)?\{/gm,
          "$1__Z_SBANG__ = {",
        );
        maskedText = maskedText.replace(
          /(^|\s)u!\s*=?\s*(\[.*?\]\s*)?\{/gm,
          "$1__Z_UBANG__ = {",
        );
        maskedText = maskedText.replace(
          /(^|\s)!\s*=?\s*(\[.*?\]\s*)?\{/gm,
          "$1__Z_BANG__ = {",
        );

        // Mask Freeform Assignments -> __Z_FREEFORM__
        maskedText = maskedText.replace(
          /\(\s*freeform\s+([a-zA-Z0-9_-]+)\s*\)/g,
          "__Z_FREEFORM__$1",
        );

        // Wrap the Z.O.N.E file in { ... } and use unique comments to force newlines
        // and easily identify the boundaries of the formatted content.
        const startMarker = "# __ZONE_FORMAT_START__";
        const endMarker = "# __ZONE_FORMAT_END__";
        const wrappedText = `{\n  ${startMarker}\n${maskedText}\n  ${endMarker}\n}`;

        return new Promise((resolve) => {
          const nixfmt = cp.spawn("nixfmt");
          let stdout = "";
          let stderr = "";

          nixfmt.stdout.on("data", (data) => {
            stdout += data.toString();
          });

          nixfmt.stderr.on("data", (data) => {
            stderr += data.toString();
          });

          nixfmt.on("error", () => {
            vscode.window.showErrorMessage(
              "nixfmt is not installed or could not be run.",
            );
            resolve([]);
          });

          nixfmt.on("close", (code) => {
            if (code === 0 && stdout) {
              let formattedText = stdout;

              const startIndex = formattedText.indexOf(startMarker);
              const endIndex = formattedText.lastIndexOf(endMarker);

              if (startIndex !== -1 && endIndex !== -1) {
                // Find how much the start marker was indented by nixfmt
                let baseIndent = 0;
                let i = startIndex - 1;
                while (i >= 0 && formattedText[i] === " ") {
                  baseIndent++;
                  i--;
                }

                let innerText = formattedText.substring(
                  startIndex + startMarker.length,
                  endIndex,
                );

                // Remove leading/trailing newlines specifically from the slice
                innerText = innerText
                  .replace(/^\r?\n/, "")
                  .replace(/\r?\n[ \t]*$/, "");

                const lines = innerText.split("\n");
                const unindentedLines = lines.map((line) => {
                  const prefix = " ".repeat(baseIndent);
                  if (line.startsWith(prefix)) {
                    return line.substring(baseIndent);
                  } else if (line.trim() === "") {
                    return ""; // clean up empty lines
                  }
                  return line;
                });

                formattedText = unindentedLines.join("\n");

                // --- UNMASKING: Restore custom Z.O.N.E. syntax ---
                formattedText = formattedText.replace(/__Z_DOL__/g, "$");
                formattedText = formattedText.replace(
                  /__Z_PATH_VAR_(\d+)__/g,
                  (match, p1) => {
                    return `($${pathVars[parseInt(p1, 10)]})`;
                  },
                );
                // Unmask conditional actions
                formattedText = formattedText.replace(
                  /__Z_SBANG__\s*=\s*\{/g,
                  "s! {",
                );
                formattedText = formattedText.replace(
                  /__Z_UBANG__\s*=\s*\{/g,
                  "u! {",
                );
                formattedText = formattedText.replace(
                  /__Z_BANG__\s*=\s*\{/g,
                  "! {",
                );
                // Unmask unconditional actions
                formattedText = formattedText.replace(
                  /__Z_SUBBANG__\s*=\s*\{/g,
                  "s!! {",
                );
                formattedText = formattedText.replace(
                  /__Z_UUBBANG__\s*=\s*\{/g,
                  "u!! {",
                );
                formattedText = formattedText.replace(
                  /__Z_DBBANG__\s*=\s*\{/g,
                  "!! {",
                );
                formattedText = formattedText.replace(
                  /__Z_FREEFORM__([a-zA-Z0-9_-]+)/g,
                  "(freeform $1)",
                );
                // Unmask dep cascade operators
                formattedText = formattedText.replace(
                  /__Z_ADDOP_(\d+)__/g,
                  (_, i) => addOps[parseInt(i, 10)],
                );
                formattedText = formattedText.replace(
                  /__Z_SUBOP_(\d+)__/g,
                  (_, i) => subOps[parseInt(i, 10)],
                );
                // Unmask _import lines (must be last — restores entire line)
                formattedText = formattedText.replace(
                  /^(\s*)__Z_IMPORT_(\d+)__\s*=\s*null\s*;?/gm,
                  (_, indent, i) => `${indent}${importLines[parseInt(i, 10)]}`,
                );

                // Preserve trailing newline if the original file had one
                if (originalText.endsWith("\n")) {
                  formattedText += "\n";
                }

                const fullRange = new vscode.Range(
                  document.positionAt(0),
                  document.positionAt(originalText.length),
                );

                resolve([vscode.TextEdit.replace(fullRange, formattedText)]);
              } else {
                vscode.window.showErrorMessage(
                  "Formatting failed: Markers were lost.",
                );
                resolve([]);
              }
            } else {
              // Expose the error so we know what broke!
              vscode.window.showErrorMessage(
                `Z.O.N.E Formatting Error: ${stderr.trim()}`,
              );
              resolve([]);
            }
          });

          nixfmt.stdin.write(wrappedText);
          nixfmt.stdin.end();
        });
      },
    });

  context.subscriptions.push(formattingProvider);
}

function scheduleDiagnostics(
  doc: vscode.TextDocument,
  collection: vscode.DiagnosticCollection,
) {
  if (diagnosticTimeout) clearTimeout(diagnosticTimeout);

  // Run the static heuristics immediately
  const heuristics = runStaticHeuristics(doc);
  const typeChecks = runTypeChecks(doc);
  const initialDiagnostics = [...heuristics, ...typeChecks];

  collection.set(doc.uri, initialDiagnostics);

  // Debounce the heavy Nix compiler check
  diagnosticTimeout = setTimeout(() => {
    runNixCompilerChecks(doc, collection, initialDiagnostics);
  }, 500);
}

function runTypeChecks(doc: vscode.TextDocument): vscode.Diagnostic[] {
  const text = doc.getText();
  const diagnostics: vscode.Diagnostic[] = [];
  const letRegex =
    /_let\s+([a-zA-Z0-9_-]+)\s*:\s*(?:\$type\.)?([a-zA-Z0-9_-]+)(?:\s*\[([\s\S]*?)\])?\s*=/g;
  let match;

  while ((match = letRegex.exec(text)) !== null) {
    const varName = match[1];
    const varType = match[2];
    const enumContent = match[3];

    const valueStartPos = match.index + match[0].length;
    let valueEndPos = text.indexOf(";", valueStartPos);
    if (valueEndPos === -1) continue; // Skip to let the syntax checker catch the missing ';'

    const valTextRaw = text.substring(valueStartPos, valueEndPos);
    const valText = valTextRaw.trim();

    if (!valText) continue;

    const startIdx = valueStartPos + valTextRaw.indexOf(valText);
    const range = new vscode.Range(
      doc.positionAt(startIdx),
      doc.positionAt(startIdx + valText.length),
    );

    if (varType === "string") {
      if (!valText.startsWith('"') && !valText.startsWith("''")) {
        diagnostics.push(
          new vscode.Diagnostic(
            range,
            `Type Error: Expected a string for '${varName}'.`,
            vscode.DiagnosticSeverity.Error,
          ),
        );
      }
    } else if (varType === "int" || varType === "integer") {
      if (!/^-?\d+$/.test(valText)) {
        diagnostics.push(
          new vscode.Diagnostic(
            range,
            `Type Error: Expected an integer for '${varName}'.`,
            vscode.DiagnosticSeverity.Error,
          ),
        );
      }
    } else if (varType === "float") {
      if (!/^-?\d+(\.\d+)?$/.test(valText)) {
        diagnostics.push(
          new vscode.Diagnostic(
            range,
            `Type Error: Expected a float for '${varName}'.`,
            vscode.DiagnosticSeverity.Error,
          ),
        );
      }
    } else if (varType === "boolean") {
      if (valText !== "true" && valText !== "false") {
        diagnostics.push(
          new vscode.Diagnostic(
            range,
            `Type Error: Expected boolean (true/false) for '${varName}'.`,
            vscode.DiagnosticSeverity.Error,
          ),
        );
      }
    } else if (varType === "enum") {
      const cleanVal = valText.replace(/^"|"$/g, "");
      const options = enumContent
        ? enumContent.match(/"([^"]+)"/g)?.map((s) => s.replace(/"/g, "")) || []
        : [];
      if (!options.includes(cleanVal)) {
        diagnostics.push(
          new vscode.Diagnostic(
            range,
            `Type Error: Value "${cleanVal}" is not a valid option for enum '${varName}'. Valid options: [${options.join(", ")}]`,
            vscode.DiagnosticSeverity.Error,
          ),
        );
      }
    }
  }

  return diagnostics;
}

function runStaticHeuristics(doc: vscode.TextDocument): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];
  const text = doc.getText();
  const lines = text.split("\n");

  const stack: { char: string; line: number; col: number }[] = [];
  const pairs: Record<string, string> = { ")": "(", "}": "{", "]": "[" };

  let arrayDepth = 0;
  let inMultiline = false;
  let insideActionBlock = false;
  let actionBlockDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;

    let cleanLine = line;
    const commentIdx = cleanLine.indexOf("#");
    if (commentIdx !== -1) cleanLine = cleanLine.substring(0, commentIdx);

    const trimmed = cleanLine.trim();
    if (trimmed.length === 0) continue;

    const startIdx = Math.max(0, cleanLine.indexOf(trimmed));
    const endIdx = startIdx + trimmed.length;

    const quoteCount = (cleanLine.match(/''/g) || []).length;
    if (quoteCount % 2 !== 0) inMultiline = !inMultiline;
    const skipHeuristics = inMultiline || insideActionBlock;

    for (let j = 0; j < cleanLine.length; j++) {
      const char = cleanLine[j];
      if (char === undefined) continue;

      if (["(", "{", "["].includes(char)) {
        stack.push({ char, line: i, col: j });
        if (char === "[") arrayDepth++;
      } else if ([")", "}", "]"].includes(char)) {
        if (char === "]") arrayDepth = Math.max(0, arrayDepth - 1);
        const last = stack.pop();
        if (!last || last.char !== pairs[char]) {
          diagnostics.push(
            new vscode.Diagnostic(
              new vscode.Range(i, j, i, j + 1),
              `Unexpected closing character '${char}'.`,
              vscode.DiagnosticSeverity.Error,
            ),
          );
        }
      }
    }

    // Track if we are inside an action block (any shorthand form) to disable static checks there
    if (
      /_(?:u|s)?action(?:_unconditional)?\s*=/.test(trimmed) ||
      /^(?:s!!|u!!|!!|s!|u!|!)(\s*\[.*?\])?\s*\{/.test(trimmed)
    ) {
      insideActionBlock = true;
      actionBlockDepth = stack.length;
    }

    if (insideActionBlock && stack.length < actionBlockDepth) {
      insideActionBlock = false;
    }

    if (!skipHeuristics) {
      const inlineMatch = cleanLine.match(/\}\s+([a-zA-Z0-9_-]+)/);
      if (inlineMatch && !["in", "then", "else"].includes(inlineMatch[1])) {
        const idx = cleanLine.lastIndexOf("}");
        diagnostics.push(
          new vscode.Diagnostic(
            new vscode.Range(i, idx, i, idx + 1),
            "Expected ';' after '}'.",
            vscode.DiagnosticSeverity.Error,
          ),
        );
      }

      if (trimmed.endsWith("}")) {
        let nextLine = "";
        for (let k = i + 1; k < lines.length; k++) {
          const nl = lines[k]?.split("#")[0].trim();
          if (nl) {
            nextLine = nl;
            break;
          }
        }

        if (nextLine && !/^[;\])}]|^(in|then|else)\b/.test(nextLine)) {
          const idx = cleanLine.lastIndexOf("}");
          diagnostics.push(
            new vscode.Diagnostic(
              new vscode.Range(i, idx, i, idx + 1),
              "Missing ';' after '}'.",
              vscode.DiagnosticSeverity.Error,
            ),
          );
        }
      }
    }

    if (arrayDepth === 0 && !skipHeuristics) {
      if (
        /^(let|in|with|inherit|if|then|else|_let)\b/.test(trimmed) ||
        trimmed.startsWith("}")
      ) {
        continue;
      }

      if (/[a-zA-Z0-9_-]/.test(trimmed)) {
        if (
          !cleanLine.includes("=") &&
          !trimmed.endsWith("{") &&
          !trimmed.endsWith("''")
        ) {
          diagnostics.push(
            new vscode.Diagnostic(
              new vscode.Range(i, startIdx, i, endIdx),
              "Missing '=' assignment.",
              vscode.DiagnosticSeverity.Error,
            ),
          );
        }

        if (cleanLine.includes("=")) {
          const validEndings = [";", "{", "[", "(", "''", "="];
          const endsValidly = validEndings.some((char) =>
            trimmed.endsWith(char),
          );

          if (!endsValidly) {
            diagnostics.push(
              new vscode.Diagnostic(
                new vscode.Range(i, startIdx, i, endIdx),
                "Missing ';' at the end of the statement.",
                vscode.DiagnosticSeverity.Error,
              ),
            );
          }
        }
      }
    }
  }

  while (stack.length > 0) {
    const unclosed = stack.pop()!;
    diagnostics.push(
      new vscode.Diagnostic(
        new vscode.Range(
          unclosed.line,
          unclosed.col,
          unclosed.line,
          unclosed.col + 1,
        ),
        `Unclosed character '${unclosed.char}'.`,
        vscode.DiagnosticSeverity.Error,
      ),
    );
  }

  return diagnostics;
}

function runNixCompilerChecks(
  doc: vscode.TextDocument,
  collection: vscode.DiagnosticCollection,
  existingDiagnostics: vscode.Diagnostic[],
) {
  const text = doc.getText();
  let masked = text;

  // 1. Mask _let declarations (preserves length for accurate error columns)
  const letRegex =
    /_let\s+[a-zA-Z0-9_-]+\s*:\s*(?:\$type\.[a-zA-Z0-9_-]+|[a-zA-Z0-9_-]+)(?:\s*\[[\s\S]*?\])?\s*=/g;
  masked = masked.replace(
    letRegex,
    (match) => "_" + " ".repeat(match.length - 2) + "=",
  );

  // 1.5. Mask Path Interpolation ($v.foo -> v       )
  masked = masked.replace(
    /\(\s*\$[a-zA-Z0-9_.-]+\s*\)/g,
    (match) => "v" + " ".repeat(match.length - 1),
  );

  // 2. Mask Zen variables ($v.foo -> v    )
  masked = masked.replace(
    /\$[a-zA-Z0-9_.-]+/g,
    (match) => "v" + " ".repeat(match.length - 1),
  );

  // 3. Mask Structural Nodes ((zmdl foo) -> n        )
  masked = masked.replace(
    /\(\s*(zmdl|alias|programs|packages|freeform|group|import|needs)(?:[^)(]|\([^)(]*\))*\)/g,
    (match) => "n" + " ".repeat(match.length - 1),
  );

  // 4. Mask all action shorthands (unconditional before conditional, to avoid partial matches)
  // s!!, u!!, !!
  masked = masked.replace(/(^|\s)s!!\s*(\[.*?\]\s*)?\{/gm, (m, pre) => pre + "_s_unco={");
  masked = masked.replace(/(^|\s)u!!\s*(\[.*?\]\s*)?\{/gm, (m, pre) => pre + "_u_unco={");
  masked = masked.replace(/(^|\s)!!\s*(\[.*?\]\s*)?\{/gm,  (m, pre) => pre + "_unco={");
  // s!, u! (with optional guard)
  masked = masked.replace(/(^|\s)s!\s*(\[.*?\]\s*)?\{/gm, (m, pre) => pre + "_s_cond={");
  masked = masked.replace(/(^|\s)u!\s*(\[.*?\]\s*)?\{/gm, (m, pre) => pre + "_u_cond={");
  // bare ! (with optional guard) — length-preserving for accurate column reporting
  masked = masked.replace(/!(\s*)\{/g, (match, spaces) => {
    if (spaces.length > 0) {
      return "_=" + " ".repeat(spaces.length - 1) + "{";
    }
    return "_={";
  });

  let isWrapped = false;
  if (
    !/^\s*(\{!?|let\b|with\b|rec\b|\[|\(|"[^"]*"|'[^']*'|[a-zA-Z0-9_-]+\s*:)/.test(
      masked,
    )
  ) {
    masked = "{\n" + masked + "\n}";
    isWrapped = true;
  }

  const nixProcess = cp.spawn("nix-instantiate", ["--parse", "-"]);

  let stderr = "";
  nixProcess.stderr.on("data", (data) => {
    stderr += data.toString();
  });

  nixProcess.on("close", (code) => {
    const diagnostics = [...existingDiagnostics];
    if (code !== 0 && stderr) {
      // Parse nix-instantiate error format: "error: syntax error, unexpected '}', expecting ';' at (stdin):1:2"
      const errMatch = stderr.match(/error: (.*?) at \(stdin\):(\d+):(\d+)/);
      if (errMatch && errMatch[2] && errMatch[3]) {
        let errLineOffset = parseInt(errMatch[2], 10) - 1; // 0-indexed
        let errColOffset = parseInt(errMatch[3], 10) - 1;

        if (isWrapped) {
          errLineOffset -= 1; // Compensate for the {\n
        }

        const targetLine = Math.max(0, errLineOffset);
        const safeCol = Math.max(0, errColOffset);

        // Protect against off-by-one line bounds in edge cases
        const maxLine = doc.lineCount - 1;
        const finalLine = Math.min(targetLine, maxLine);

        const range = new vscode.Range(
          finalLine,
          safeCol,
          finalLine,
          safeCol + 1,
        );

        diagnostics.push(
          new vscode.Diagnostic(
            range,
            `Syntax Error: ${errMatch[1]}`,
            vscode.DiagnosticSeverity.Error,
          ),
        );
      }
    }

    collection.set(doc.uri, diagnostics);
  });

  nixProcess.stdin.write(masked);
  nixProcess.stdin.end();
}

export function deactivate() {}
