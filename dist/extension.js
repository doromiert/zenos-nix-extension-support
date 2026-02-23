"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const cp = require("child_process");
let diagnosticTimeout = undefined;
function activate(context) {
    const zenSelector = { scheme: "file", language: "zen-nix" };
    const completionProvider = vscode.languages.registerCompletionItemProvider(zenSelector, {
        provideCompletionItems(document, position) {
            const completions = [];
            const linePrefix = document.lineAt(position).text;
            // Helper to explicitly calculate the overwrite range, bypassing VS Code's word engine
            const createItemWithRange = (label, kind, insert, detail, matchText) => {
                const item = new vscode.CompletionItem(label, kind);
                item.insertText = new vscode.SnippetString(insert);
                item.detail = detail;
                const startPos = position.character - matchText.length;
                item.range = new vscode.Range(position.line, Math.max(0, startPos), position.line, position.character);
                return item;
            };
            // 1. $ Variables Context
            const dollarMatch = linePrefix.match(/\$[a-zA-Z0-9_-]*$/);
            if (dollarMatch) {
                ["$m", "$f", "$name", "$path"].forEach((v) => {
                    completions.push(createItemWithRange(v, vscode.CompletionItemKind.Variable, `\\${v}`, "ZenOS Context Variable", dollarMatch[0]));
                });
                return completions;
            }
            // 2. _ Meta Nodes Context
            const underscoreMatch = linePrefix.match(/_[a-zA-Z0-9_-]*$/);
            if (underscoreMatch) {
                completions.push(createItemWithRange("_meta", vscode.CompletionItemKind.Struct, '_meta = {\n    brief = "${1:Description}";\n    type = ${2:type};\n    default = ${3:null};\n    license = ${4:lib.licenses.mit};\n    maintainers = [ ${5} ];\n};', "ZenOS Metadata Block", underscoreMatch[0]));
                ["action", "saction", "uaction"].forEach((act) => {
                    completions.push(createItemWithRange(`_${act}`, vscode.CompletionItemKind.Function, `_${act}`, `ZenOS ${act.toUpperCase()} Hook`, underscoreMatch[0]));
                });
                return completions;
            }
            // 3. ( Keywords Context
            const parenMatch = linePrefix.match(/\([a-zA-Z0-9_-]*$/);
            if (parenMatch) {
                const createParenItem = (label, insert, detail) => {
                    const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Keyword);
                    item.insertText = new vscode.SnippetString(insert);
                    item.detail = detail;
                    const startPos = position.character - parenMatch[0].length;
                    item.range = new vscode.Range(position.line, Math.max(0, startPos), position.line, position.character);
                    return item;
                };
                completions.push(createParenItem("zmdl", "(zmdl ${1:target})", "Zen Module Node"));
                completions.push(createParenItem("alias", "(alias ${1:target})", "Zen Alias Node"));
                ["programs", "packages", "freeform"].forEach((kw) => {
                    completions.push(createParenItem(kw, `(${kw})`, "ZenOS Structural Node"));
                });
                return completions;
            }
            // 4. Default Context (Types)
            if (!/[$_(][a-zA-Z0-9_-]*$/.test(linePrefix)) {
                ["boolean", "string", "int", "enum"].forEach((t) => {
                    const item = new vscode.CompletionItem(t, vscode.CompletionItemKind.TypeParameter);
                    item.detail = "ZenOS Value Type";
                    completions.push(item);
                });
            }
            return completions;
        },
    }, "_", "$", "(");
    const diagnosticCollection = vscode.languages.createDiagnosticCollection("zen-nix");
    vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.languageId === "zen-nix") {
            scheduleDiagnostics(event.document, diagnosticCollection);
        }
    });
    if (vscode.window.activeTextEditor &&
        vscode.window.activeTextEditor.document.languageId === "zen-nix") {
        scheduleDiagnostics(vscode.window.activeTextEditor.document, diagnosticCollection);
    }
    context.subscriptions.push(completionProvider, diagnosticCollection);
    // --- 3. Document Formatting Provider ---
    const formattingProvider = vscode.languages.registerDocumentFormattingEditProvider(zenSelector, {
        provideDocumentFormattingEdits(document) {
            return new Promise((resolve) => {
                const text = document.getText();
                let prepText = text;
                let isWrapped = false;
                // Dictionary to hold masked non-standard syntax
                const maskDict = new Map();
                let maskId = 0;
                // Helper to replace and store
                const maskMatch = (match, prefix) => {
                    const placeholder = `__ZEN_${prefix}_${maskId++}__`;
                    maskDict.set(placeholder, match);
                    return placeholder;
                };
                // 1. Mask ZenOS Context Variables ($m, $name, etc.)
                prepText = prepText.replace(/\$[a-zA-Z0-9_-]+/g, (match) => maskMatch(match, "VAR"));
                // 2. Mask ZenOS Structural Nodes ((zmdl target), (programs), etc.)
                // This matches the keyword and anything inside until the closing parenthesis
                // 2. Mask ZenOS Structural Nodes ((zmdl target), (programs), etc.)
                // This regex supports up to one level of nested parentheses (e.g., `($f.user)`)
                prepText = prepText.replace(/\(\s*(zmdl|alias|programs|packages|freeform)(?:[^)(]|\([^)(]*\))*\)/g, (match) => maskMatch(match, "NODE"));
                // 3. Auto-wrap bare attribute lists missing the top-level { }
                if (!/^\s*(\{!?|let\b|with\b|rec\b|\[|\(|"[^"]*"|'[^']*'|[a-zA-Z0-9_-]+\s*:)/.test(prepText)) {
                    prepText = "{\n" + prepText + "\n}";
                    isWrapped = true;
                }
                const nixfmtProcess = cp.spawn("nixfmt");
                let stdout = "";
                let stderr = "";
                nixfmtProcess.stdout.on("data", (data) => {
                    stdout += data.toString();
                });
                nixfmtProcess.stderr.on("data", (data) => {
                    stderr += data.toString();
                });
                nixfmtProcess.on("close", (code) => {
                    if (code === 0 && stdout.length > 0) {
                        let finalText = stdout;
                        // 4. Unwrap if we artificially wrapped it
                        if (isWrapped) {
                            finalText = finalText.trim();
                            if (finalText.startsWith("{"))
                                finalText = finalText.substring(1);
                            if (finalText.endsWith("}"))
                                finalText = finalText.substring(0, finalText.length - 1);
                            // Strip the 2-space indentation added by nixfmt for the wrapper
                            finalText = finalText.replace(/^  /gm, "");
                            finalText = finalText.trim() + "\n";
                        }
                        // 5. Restore all ZenOS syntax from the dictionary
                        maskDict.forEach((originalText, placeholder) => {
                            // Use global replace in case the token appeared multiple times
                            finalText = finalText.replace(new RegExp(placeholder, "g"), originalText);
                        });
                        const fullRange = new vscode.Range(document.lineAt(0).range.start, document.lineAt(document.lineCount - 1).range.end);
                        resolve([vscode.TextEdit.replace(fullRange, finalText)]);
                    }
                    else {
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
function scheduleDiagnostics(doc, collection) {
    if (diagnosticTimeout)
        clearTimeout(diagnosticTimeout);
    // Run the static heuristics immediately
    const heuristics = runStaticHeuristics(doc);
    collection.set(doc.uri, heuristics);
    // Debounce the heavy Nix compiler check
    diagnosticTimeout = setTimeout(() => {
        runNixCompilerChecks(doc, collection, heuristics);
    }, 500);
}
function runStaticHeuristics(doc) {
    const diagnostics = [];
    const text = doc.getText();
    const lines = text.split("\n");
    const stack = [];
    const pairs = { ")": "(", "}": "{", "]": "[" };
    let arrayDepth = 0;
    let inMultiline = false;
    let insideActionBlock = false;
    let actionBlockDepth = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined)
            continue;
        let cleanLine = line;
        const commentIdx = cleanLine.indexOf("#");
        if (commentIdx !== -1)
            cleanLine = cleanLine.substring(0, commentIdx);
        const trimmed = cleanLine.trim();
        if (trimmed.length === 0)
            continue;
        const startIdx = Math.max(0, cleanLine.indexOf(trimmed));
        const endIdx = startIdx + trimmed.length;
        const quoteCount = (cleanLine.match(/''/g) || []).length;
        if (quoteCount % 2 !== 0)
            inMultiline = !inMultiline;
        const skipHeuristics = inMultiline || insideActionBlock;
        for (let j = 0; j < cleanLine.length; j++) {
            const char = cleanLine[j];
            if (char === undefined)
                continue;
            if (["(", "{", "["].includes(char)) {
                stack.push({ char, line: i, col: j });
                if (char === "[")
                    arrayDepth++;
            }
            else if ([")", "}", "]"].includes(char)) {
                if (char === "]")
                    arrayDepth = Math.max(0, arrayDepth - 1);
                const last = stack.pop();
                if (!last || last.char !== pairs[char]) {
                    diagnostics.push(new vscode.Diagnostic(new vscode.Range(i, j, i, j + 1), `Unexpected closing character '${char}'.`, vscode.DiagnosticSeverity.Error));
                }
            }
        }
        // Track if we are inside an _action, _saction, or _uaction to disable static checks there
        if (/_(?:u|s)?action\s*=/.test(trimmed)) {
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
                diagnostics.push(new vscode.Diagnostic(new vscode.Range(i, idx, i, idx + 1), "Expected ';' after '}'.", vscode.DiagnosticSeverity.Error));
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
                    diagnostics.push(new vscode.Diagnostic(new vscode.Range(i, idx, i, idx + 1), "Missing ';' after '}'.", vscode.DiagnosticSeverity.Error));
                }
            }
        }
        if (arrayDepth === 0 && !skipHeuristics) {
            if (/^(let|in|with|inherit|if|then|else)\b/.test(trimmed) ||
                trimmed.startsWith("}")) {
                continue;
            }
            if (/[a-zA-Z0-9_-]/.test(trimmed)) {
                if (!cleanLine.includes("=") &&
                    !trimmed.endsWith("{") &&
                    !trimmed.endsWith("''")) {
                    diagnostics.push(new vscode.Diagnostic(new vscode.Range(i, startIdx, i, endIdx), "Missing '=' assignment.", vscode.DiagnosticSeverity.Error));
                }
                if (cleanLine.includes("=")) {
                    const validEndings = [";", "{", "[", "(", "''", "="];
                    const endsValidly = validEndings.some((char) => trimmed.endsWith(char));
                    if (!endsValidly) {
                        diagnostics.push(new vscode.Diagnostic(new vscode.Range(i, startIdx, i, endIdx), "Missing ';' at the end of the statement.", vscode.DiagnosticSeverity.Error));
                    }
                }
            }
        }
    }
    while (stack.length > 0) {
        const unclosed = stack.pop();
        diagnostics.push(new vscode.Diagnostic(new vscode.Range(unclosed.line, unclosed.col, unclosed.line, unclosed.col + 1), `Unclosed character '${unclosed.char}'.`, vscode.DiagnosticSeverity.Error));
    }
    return diagnostics;
}
function runNixCompilerChecks(doc, collection, existingDiagnostics) {
    const text = doc.getText();
    const actionRegex = /_(?:u|s)?action\s*=\s*([\s\S]*?);(?=\s*(?:_|$|\}))/g;
    let match;
    const diagnostics = [...existingDiagnostics];
    let pendingChecks = 0;
    while ((match = actionRegex.exec(text)) !== null) {
        const actionBody = match[1];
        if (!actionBody)
            continue;
        const startPos = doc.positionAt(match.index + match[0].indexOf(actionBody));
        pendingChecks++;
        // Wrap the block in a dummy assignment to ensure it parses as a valid Nix expression
        const nixExpr = `let dummy = ${actionBody}; in dummy`;
        const nixProcess = cp.spawn("nix-instantiate", ["--parse", "-"]);
        let stderr = "";
        nixProcess.stderr.on("data", (data) => {
            stderr += data.toString();
        });
        nixProcess.on("close", (code) => {
            if (code !== 0 && stderr) {
                // Parse nix-instantiate error format: "error: syntax error, unexpected '}', expecting ';' at (stdin):1:2"
                const errMatch = stderr.match(/error: (.*?) at \(stdin\):(\d+):(\d+)/);
                if (errMatch && errMatch[2] && errMatch[3]) {
                    const errLineOffset = parseInt(errMatch[2], 10) - 1; // 0-indexed
                    const errColOffset = parseInt(errMatch[3], 10) - 1;
                    // Calculate real position in the document
                    const targetLine = startPos.line + errLineOffset;
                    let targetCol = errColOffset;
                    if (errLineOffset === 0) {
                        // Account for the "let dummy = " string prefix injection length (12 chars)
                        targetCol = startPos.character + errColOffset - 12;
                    }
                    const safeCol = Math.max(0, targetCol);
                    const range = new vscode.Range(targetLine, safeCol, targetLine, safeCol + 1);
                    diagnostics.push(new vscode.Diagnostic(range, `Nix Compiler: ${errMatch[1]}`, vscode.DiagnosticSeverity.Error));
                }
            }
            pendingChecks--;
            if (pendingChecks === 0) {
                collection.set(doc.uri, diagnostics);
            }
        });
        nixProcess.stdin.write(nixExpr);
        nixProcess.stdin.end();
    }
    if (pendingChecks === 0) {
        collection.set(doc.uri, diagnostics);
    }
}
function deactivate() { }
//# sourceMappingURL=extension.js.map