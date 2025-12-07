# C# Complex Return Type Detection Fix

## Problem

Function detection in `.cs` and `.xaml.cs` files was failing for methods with:
1. **Complex generic return types** containing spaces (e.g., `Dictionary<string, int>`)
2. **Nullable types** (e.g., `int?`)
3. **Tuples** (e.g., `(int, string)`)
4. **Pointers** (e.g., `void*`)

The previous regex `[\w<>[\],]+` assumed return types only contained alphanumeric characters, angle brackets, square brackets, and commas. It failed when encountering spaces (common in multi-argument generics) or other symbols.

## Solution

Updated the regex patterns in `SemanticAnalyzer.ts` and `SemanticChangesPanel.ts` to use a non-greedy match `(.+?)` (or `(?:.+?)`) for the return type, which matches *any* character sequence until the function name.

### New Pattern Strategy

```typescript
// Old Pattern (SemanticAnalyzer)
/^\+.*\b(modifiers...)(?:\s+(modifiers...))*\s+[\w<>[\],]+\s+\w+\s*\(/

// Old Pattern (SemanticChangesPanel)
/^\s*(?:modifiers...)+\w+\s+(\w+)\s*\(/

// New Pattern (Both)
/^\s*(?:modifiers...)(?:\s+(modifiers...))*\s+(?:.+?)\s+(\w+)\s*\(/
```

This ensures that:
1. We still require valid modifiers at the start.
2. We capture the function name as the *last* word before the opening parenthesis `(`.
3. The return type can be anything in between (including spaces, complex generics, tuples, etc.).

## Affected Files

1. `src/analysis/semantic-analyzer.ts`:
   - `ADD_FUNCTION_PATTERNS`
   - `DELETE_FUNCTION_PATTERNS`
   - `extractFunctionName()`
   - `extractFunctionNameFromContext()`

2. `src/views/semantic-changes-panel.ts`:
   - `addFunctionContextToHunks` (internal regex list)

## Verification

Verified with `repro_test.js` covering:
- `Task<string>` (Simple generic)
- `string[]` (Array)
- `Dictionary<string, int>` (Generic with space)
- `protected virtual void` (Multiple modifiers)

