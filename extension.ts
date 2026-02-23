import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext) {
  const zenSelector = { scheme: "file", language: "zen-nix" };

  // 1. IntelliSense Provider
  const completionProvider = vscode.languages.registerCompletionItemProvider(
    zenSelector,
    {
      provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
      ) {
        const completions: vscode.CompletionItem[] = [];

        // --- Variables ---
        const zargs = new vscode.CompletionItem(
          "__zargs",
          vscode.CompletionItemKind.Variable,
        );
        zargs.detail = "ZenOS Evaluation Arguments";
        completions.push(zargs);

        // --- Internal Meta Nodes ---
        const metaBlock = new vscode.CompletionItem(
          "_meta",
          vscode.CompletionItemKind.Struct,
        );
        metaBlock.insertText = new vscode.SnippetString(
          '_meta = {\n    brief = "${1:Description}";\n    type = ${2:type};\n    default = ${3:null};\n    license = ${4:lib.licenses.mit};\n    maintainers = [ ${5} ];\n};',
        );
        metaBlock.detail = "ZenOS Metadata Block";

        const typeAttr = new vscode.CompletionItem(
          "_type",
          vscode.CompletionItemKind.Property,
        );
        typeAttr.insertText = new vscode.SnippetString(
          '_type = "${1|enableOption,alias,zmdl,programs,packages|}";',
        );

        ["action", "saction", "uaction"].forEach((act) => {
          const actionItem = new vscode.CompletionItem(
            `_${act}`,
            vscode.CompletionItemKind.Function,
          );
          actionItem.detail = `ZenOS ${act.toUpperCase()} Hook`;
          completions.push(actionItem);
        });

        completions.push(metaBlock, typeAttr);

        // --- Types (From mapZType) ---
        ["boolean", "string", "int", "enum", "enableOption"].forEach((t) => {
          const typeItem = new vscode.CompletionItem(
            t,
            vscode.CompletionItemKind.TypeParameter,
          );
          typeItem.detail = "ZenOS Value Type";
          completions.push(typeItem);
        });

        // --- Zen structural keywords ---
        const zmdl = new vscode.CompletionItem(
          "zmdl",
          vscode.CompletionItemKind.Keyword,
        );
        zmdl.insertText = new vscode.SnippetString("(zmdl ${1:target})");
        zmdl.detail = "Zen Module Node";

        const alias = new vscode.CompletionItem(
          "alias",
          vscode.CompletionItemKind.Keyword,
        );
        alias.insertText = new vscode.SnippetString("(alias ${1:target})");
        alias.detail = "Zen Alias Node";

        ["programs", "packages", "freeform"].forEach((kw) => {
          const kwItem = new vscode.CompletionItem(
            kw,
            vscode.CompletionItemKind.Keyword,
          );
          kwItem.insertText = new vscode.SnippetString(`(${kw})`);
          kwItem.detail = "ZenOS Structural Node";
          completions.push(kwItem);
        });

        completions.push(zmdl, alias);

        return completions;
      },
    },
    "_",
    "$",
    "(", // Trigger characters
  );

  // 2. Syntax Error Diagnostics
  const diagnosticCollection =
    vscode.languages.createDiagnosticCollection("zen-nix");

  // Validate on typing (with debounce ideally, but direct for simplicity)
  vscode.workspace.onDidChangeTextDocument((event: any) => {
    if (event.document.languageId === "zen-nix") {
      refreshDiagnostics(event.document, diagnosticCollection);
    }
  });

  // Validate active editor on load
  if (
    vscode.window.activeTextEditor &&
    vscode.window.activeTextEditor.document.languageId === "zen-nix"
  ) {
    refreshDiagnostics(
      vscode.window.activeTextEditor.document,
      diagnosticCollection,
    );
  }

  context.subscriptions.push(completionProvider, diagnosticCollection);
}

function refreshDiagnostics(
  doc: vscode.TextDocument,
  collection: vscode.DiagnosticCollection,
) {
  const diagnostics: vscode.Diagnostic[] = [];
  const text = doc.getText();
  const lines = text.split("\n");

  // A stack to track brackets/parens/braces for structural validation
  const stack: { char: string; line: number; col: number }[] = [];
  const pairs: Record<string, string> = { ")": "(", "}": "{", "]": "[" };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 1. Check for invalid Zen types inside parens
    const zenNodeMatch = line.match(/\(\s*([a-zA-Z0-9_-]+)/);
    if (zenNodeMatch) {
      const keyword = zenNodeMatch[1];
      const validKeywords = [
        "zmdl",
        "alias",
        "programs",
        "packages",
        "freeform",
      ];
      if (!validKeywords.includes(keyword) && !line.includes("(" + keyword)) {
        // If it's a func call in standard nix this might false-positive,
        // refine regex to catch strict ZenOS node syntax if needed.
      }
    }

    // 2. Bracket matching logic
    for (let j = 0; j < line.length; j++) {
      const char = line[j];

      // Skip comments
      if (char === "#" && line[j + 1] !== "{") break;

      if (["(", "{", "["].includes(char)) {
        stack.push({ char, line: i, col: j });
      } else if ([")", "}", "]"].includes(char)) {
        const last = stack.pop();
        if (!last || last.char !== pairs[char]) {
          const range = new vscode.Range(i, j, i, j + 1);
          diagnostics.push(
            new vscode.Diagnostic(
              range,
              `Unexpected closing character '${char}'.`,
              vscode.DiagnosticSeverity.Error,
            ),
          );
        }
      }
    }
  }

  // Mark unclosed brackets
  while (stack.length > 0) {
    const unclosed = stack.pop()!;
    const range = new vscode.Range(
      unclosed.line,
      unclosed.col,
      unclosed.line,
      unclosed.col + 1,
    );
    diagnostics.push(
      new vscode.Diagnostic(
        range,
        `Unclosed character '${unclosed.char}'.`,
        vscode.DiagnosticSeverity.Error,
      ),
    );
  }

  collection.set(doc.uri, diagnostics);
}

export function deactivate() {}
