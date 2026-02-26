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
            { label: "action", detail: "Universal execution logic" },
            { label: "saction", detail: "System-level execution logic" },
            { label: "uaction", detail: "User-level execution logic" },
          ].forEach((kw) => {
            completions.push(
              createItemWithRange(
                `_${kw.label}`,
                vscode.CompletionItemKind.Keyword,
                kw.label,
                kw.detail,
                keywordMatch[0],
              ),
            );
          });
        }

        // 4. Action Shorthands (Expands to valid Nix syntax for nixfmt compatibility)
        const shorthandMatch = linePrefix.match(/(?:^|\s)([su]!?|!)$/);
        const isBlankLine = linePrefix.trim().length === 0;

        if (shorthandMatch || isBlankLine) {
          const matchText = shorthandMatch ? shorthandMatch[1] : "";
          [
            {
              label: "!",
              insert: "_action =",
              detail: "Universal Action Shorthand",
            },
            {
              label: "s!",
              insert: "_saction =",
              detail: "System Action Shorthand",
            },
            {
              label: "u!",
              insert: "_uaction =",
              detail: "User Action Shorthand",
            },
          ].forEach((sh) => {
            // Prevent 's' from incorrectly suggesting 'u!'
            if (matchText && !sh.label.startsWith(matchText[0])) {
              if (matchText !== "!") return;
            }

            completions.push(
              createItemWithRange(
                sh.label,
                vscode.CompletionItemKind.Snippet,
                `${sh.insert} {\n\t$0\n}`,
                sh.detail,
                matchText || "",
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
      ): Promise<vscode.TextEdit[]> {
        return new Promise((resolve) => {
          const text = document.getText();

          let prepText = text;
          let isWrapped = false;

          // Dictionary to hold masked non-standard syntax
          const maskDict = new Map<string, string>();
          let maskId = 0;

          // Helper to replace and store
          const maskMatch = (match: string, prefix: string) => {
            const placeholder = `__ZEN_${prefix}_${maskId++}__`;
            maskDict.set(placeholder, match);
            return placeholder;
          };

          // 1. Mask ZenOS _let Variable Declarations
          let newPrepText = "";
          let currentIndex = 0;
          const letRegex =
            /_let\s+[a-zA-Z0-9_-]+\s*:\s*(?:\$type\.[a-zA-Z0-9_-]+|[a-zA-Z0-9_-]+)/g;
          let letMatch;

          while ((letMatch = letRegex.exec(prepText)) !== null) {
            newPrepText += prepText.substring(currentIndex, letMatch.index);
            let i = letMatch.index + letMatch[0].length;
            let depth = 0;
            let inString = false;

            // Scan forward to safely locate the matching '=' assignment
            for (; i < prepText.length; i++) {
              const char = prepText[i];
              if (char === '"' && prepText[i - 1] !== "\\") {
                inString = !inString;
              }
              if (!inString) {
                if (char === "[" || char === "{" || char === "(") depth++;
                if (char === "]" || char === "}" || char === ")") depth--;
                if (depth === 0 && char === "=") {
                  break;
                }
              }
            }

            if (i < prepText.length && prepText[i] === "=") {
              const beforeArray = letMatch[0];
              const middleContent = prepText
                .substring(letMatch.index + letMatch[0].length, i)
                .trim();

              if (middleContent.length > 0) {
                // If there's an array, split the mask so nixfmt can format the middle array natively
                const startPlaceholder = `__ZEN_LET_S_${maskId}__`;
                const endPlaceholder = `__ZEN_LET_E_${maskId}__`;
                maskDict.set(startPlaceholder, beforeArray);
                maskDict.set(endPlaceholder, "=");
                maskId++;

                newPrepText += `${startPlaceholder} = ${middleContent};\n${endPlaceholder} =`;
              } else {
                // No array (e.g. basic string/int type), mask normally
                // Only take the text UP TO the '=' so the equal sign is left exposed for nixfmt
                const fullMatch = prepText.substring(letMatch.index, i);
                const placeholder = `__ZEN_LET_${maskId++}__`;
                maskDict.set(placeholder, fullMatch.trimEnd());
                newPrepText += placeholder + " ="; // Keep the '=' unmasked so nixfmt recognizes assignment
              }
              currentIndex = i + 1; // skip '='
            } else {
              newPrepText += letMatch[0];
              currentIndex = letMatch.index + letMatch[0].length;
            }
          }
          newPrepText += prepText.substring(currentIndex);
          prepText = newPrepText;

          // 2. Mask ZenOS Context Variables ($m, $name, etc.)
          prepText = prepText.replace(/\$[a-zA-Z0-9_-]+/g, (match) =>
            maskMatch(match, "VAR"),
          );

          // 3. Mask ZenOS Structural Nodes ((zmdl target), (programs), etc.)
          // This regex supports up to one level of nested parentheses (e.g., `($f.user)`)
          prepText = prepText.replace(
            /\(\s*(zmdl|alias|programs|packages|freeform|group|import|needs)(?:[^)(]|\([^)(]*\))*\)/g,
            (match) => maskMatch(match, "NODE"),
          );

          // 4. Mask Shorthand ! -> __ZEN_BANG_x__ =
          // Nixfmt cannot format a bare expression inside an attribute list, so we map it to an assignment.
          prepText = prepText.replace(/!(\s*\{)/g, (match, brace) => {
            const placeholder = `__ZEN_BANG_${maskId++}__ =${brace}`;
            maskDict.set(placeholder, match);
            return placeholder;
          });

          // 5. Auto-wrap bare attribute lists missing the top-level { }
          if (
            !/^\s*(\{!?|let\b|with\b|rec\b|\[|\(|"[^"]*"|'[^']*'|[a-zA-Z0-9_-]+\s*:)/.test(
              prepText,
            )
          ) {
            prepText = "{\n" + prepText + "\n}";
            isWrapped = true;
          }

          const nixfmtProcess = cp.spawn("nixfmt");

          let stdout = "";
          let stderr = "";

          nixfmtProcess.stdout.on("data", (data: Buffer | string) => {
            stdout += data.toString();
          });

          nixfmtProcess.stderr.on("data", (data: Buffer | string) => {
            stderr += data.toString();
          });

          nixfmtProcess.on("close", (code: number | null) => {
            if (code === 0 && stdout.length > 0) {
              let finalText = stdout;

              // 4. Unwrap if we artificially wrapped it
              if (isWrapped) {
                finalText = finalText.trim();
                if (finalText.startsWith("{"))
                  finalText = finalText.substring(1);
                if (finalText.endsWith("}"))
                  finalText = finalText.substring(0, finalText.length - 1);

                finalText = finalText.trim() + "\n";
              }

              // 5. Restore all ZenOS syntax from the dictionary
              // Reverse the order to prevent nested placeholders (e.g. __ZEN_NODE_x__ containing __ZEN_VAR_y__)
              // from leaving unresolved variables when unmasked in the wrong order.
              const placeholders = Array.from(maskDict.keys()).reverse();
              for (const placeholder of placeholders) {
                const originalText = maskDict.get(placeholder)!;
                if (placeholder.startsWith("__ZEN_LET_S_")) {
                  // Special replacement to eat the `=` added for nixfmt
                  finalText = finalText.replace(
                    new RegExp(placeholder + "\\s*="),
                    () => originalText,
                  );
                } else if (placeholder.startsWith("__ZEN_LET_E_")) {
                  // Special replacement to eat the `;` added for nixfmt
                  finalText = finalText.replace(
                    new RegExp(";\\s*" + placeholder + "\\s*="),
                    () => " =",
                  );
                } else {
                  finalText = finalText.replace(
                    new RegExp(placeholder, "g"),
                    () => originalText, // Arrow function prevents '$$' escaping behaviors
                  );
                }
              }

              const fullRange = new vscode.Range(
                document.lineAt(0).range.start,
                document.lineAt(document.lineCount - 1).range.end,
              );
              resolve([vscode.TextEdit.replace(fullRange, finalText)]);
            } else {
              vscode.window.showWarningMessage(`nixfmt failed: ${stderr}`);
              resolve([]);
            }
          });

          nixfmtProcess.stdin.write(prepText);
          nixfmtProcess.stdin.end();
        });
      },
    });
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

    // Track if we are inside an _action, _saction, _uaction, or an immediate action (!) to disable static checks there
    if (/_(?:u|s)?action\s*=/.test(trimmed) || /^!(\s*\{|$)/.test(trimmed)) {
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

  // 4. Mask Bang Action (! { -> _= { )
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
