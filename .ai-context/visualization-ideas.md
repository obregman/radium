# Static Analysis Visualization Ideas (No LLM)

This document outlines visualization enhancements for the Semantic Changes view that can be implemented using deterministic static analysis and git data, without requiring an LLM.

## 1. Complexity Metrics
Visualize the structural complexity of the introduced changes.

*   **Cyclomatic Complexity Delta**: Show if the change makes the code harder to test/maintain.
    *   *Implementation*: Parse the `diff` or new function body. Count branching keywords (`if`, `for`, `while`, `case`, `catch`, `?`, `&&`, `||`). Compare the count in the new code vs. the old code. Display as `Complexity: +2` or a colored arrow.
*   **Nesting Depth Indicator**: Highlight deeply nested logic which is hard to read.
    *   *Implementation*: Calculate the maximum indentation level (or AST depth) of the added lines relative to the function start. If depth > 3, show a warning icon or "Depth" bar.

## 2. Test Gap Detection
Warn when logic changes without corresponding tests.

*   **Missing Test Update**: Flag files that have logic changes but no corresponding test file update.
    *   *Implementation*:
        1.  For modified file `src/MyComponent.ts`, generate expected test paths (e.g., `src/MyComponent.test.ts`, `tests/MyComponent.spec.ts`).
        2.  Check if any of those expected test files are in the current list of changed files.
        3.  If not, display a "Missing Test?" badge.

## 3. API & Breaking Change Detection
Identify changes that might break other parts of the system.

*   **Breaking Signature Change**: specific alert when an exported function's signature changes incompatible.
    *   *Implementation*: Compare the old and new function signature lines.
        *   Changed parameter types?
        *   Reduced number of parameters?
        *   Changed return type?
        *   If yes, tag as `Breaking Change`.
*   **Exported Surface Change**: distinct visual style for changes to `exported` items.
    *   *Implementation*: Check if the modified function/class has the `export` keyword (TS/JS) or `public` modifier (C#/Java).

## 4. Security & Sensitivity Radar
Highlight changes involving sensitive domains.

*   **Sensitive Pattern Alert**: Visual indicator for code touching security-critical areas.
    *   *Implementation*: Run a regex scan on the added lines for keywords: `password`, `token`, `auth`, `encrypt`, `secret`, `privateKey`, `fs.`, `database.`. Display a "Security" or "IO" icon if matched.

## 5. Impact Analysis (Usage Count)
Estimate how widely used a modified function is.

*   **Usage Counter**: "Used in ~5 places".
    *   *Implementation*:
        1.  Extract the name of the modified function.
        2.  Run a fast text search (like `ripgrep` or VS Code's `findTextInFiles`) for that function name across the workspace.
        3.  Count the number of matches (excluding the definition file).
        4.  Display a "High Impact" badge if count > threshold.
