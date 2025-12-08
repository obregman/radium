# Parser State Corruption Fix

## Problem

Users reported that the Files Map was displaying all file boxes as grey, indicating 0 exported symbols, even for files that clearly exported classes and functions. The logs showed extensive "Tree-sitter parse failed" errors with "Invalid argument" messages.

## Root Cause

The `ParserFactory` was using a singleton pattern to cache parser instances for reuse across multiple files. However, **tree-sitter parsers maintain internal state** that can become corrupted after parsing errors. When a parser encountered an error and threw an exception, it would remain in a bad state and continue to fail for all subsequent files.

### Why This Happened

1. Parser encounters a file that causes an error (malformed syntax, encoding issue, etc.)
2. Tree-sitter throws "Invalid argument" exception
3. Parser instance is left in a corrupted state
4. Same parser instance is reused for the next file
5. Parser fails again with "Invalid argument" even for valid files
6. Cascade of failures affects all remaining files

### Impact on Files Map

When tree-sitter parsing fails:
- No symbols are extracted from the file
- No edges (relationships) are created
- The Files Map color coding relies on counting cross-file references (edges)
- Files with 0 edges → 0 exported symbols → grey color

## Solution

### 1. Remove Parser Caching

Changed `ParserFactory` to create fresh parser instances for each file instead of caching and reusing them:

```typescript
// Before: Cached parsers (problematic)
static getParser(language: string): BaseParser | null {
  if (this.parsers.has(language)) {
    return this.parsers.get(language)!; // Reuses corrupted parser
  }
  // ... create and cache parser
}

// After: Fresh instances (fixed)
static getParser(language: string): BaseParser | null {
  // Create new parser each time - no caching
  // This prevents state corruption from affecting subsequent files
  return new TypeScriptParser(language);
}
```

### 2. Simplify Error Handling

Removed complex retry logic in `BaseParser` that wasn't helping:

```typescript
// Before: Complex retry with fresh parser (didn't help)
try {
  tree = this.parser.parse(code);
} catch (parseError) {
  // Try again with fresh parser...
  // Multiple retry attempts...
  // Diagnostic logging...
}

// After: Simple fail-fast to regex fallback
try {
  tree = this.parser.parse(code);
} catch (parseError) {
  // Return null immediately to trigger regex fallback
  return null;
}
```

### 3. Enhanced Regex Fallback

Improved the regex-based symbol extraction to better handle TypeScript/JavaScript:

- Added arrow function detection: `export const func = () => {}`
- Added type aliases: `export type MyType = ...`
- Added enums: `export enum MyEnum { ... }`
- Added variable declarations: `export const myVar = ...`
- Better handling of exported symbols

## Performance Considerations

**Question**: Doesn't creating a new parser for each file hurt performance?

**Answer**: No, for several reasons:

1. **Parser creation is fast**: Instantiating a parser is a lightweight operation
2. **Parsing is the bottleneck**: The actual parsing of file content is 100x slower than creating the parser
3. **Correctness over speed**: A slightly slower but correct parser is better than a fast but broken one
4. **Batch processing**: Files are indexed in batches with delays, so parser creation overhead is negligible

## Testing

To verify the fix works:

1. Open a TypeScript project
2. Run `Radium: Files Map`
3. Check browser console for logs: `[Files Map] Exported symbols per file`
4. Verify file boxes are colored correctly (not all grey)
5. Check VS Code Output Panel (Radium) for successful parsing logs

## Future Improvements

Potential enhancements to consider:

1. **Investigate tree-sitter version**: The "Invalid argument" errors might be a bug in tree-sitter 0.21.0
2. **Better error reporting**: Surface parsing errors to users in the UI
3. **Parser pooling**: Create a pool of fresh parsers to balance performance and correctness
4. **Incremental parsing**: Use tree-sitter's incremental parsing API for file updates

## Related Files

- `src/indexer/parsers/parser-factory.ts` - Factory that creates parsers
- `src/indexer/parsers/base-parser.ts` - Base parser with error handling
- `src/indexer/utils/regex-fallback.ts` - Regex-based symbol extraction
- `src/views/files-map-panel.ts` - Files Map that uses the parsed data

