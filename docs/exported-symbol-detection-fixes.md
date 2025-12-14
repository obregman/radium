# Exported Symbol Detection Fixes

This document describes two bugs that caused exported symbols to not be properly tracked in the Files Map.

---

## Bug 1: C# Using Directive Parsing

### Issue
The C# parser was not extracting `using` directives (imports), causing files with C# code to show 0 exports in the Files Map.

### Root Cause
In `src/indexer/parsers/csharp-parser.ts`, the code was using `node.childForFieldName('name')` to extract the namespace from a `using_directive` node. However, the tree-sitter-c-sharp grammar does not define a named `name` field for using directives - instead, it has `identifier` or `qualified_name` as direct children.

### Before (broken)
```typescript
else if (node.type === 'using_directive') {
  const nameNode = node.childForFieldName('name');  // Always returns undefined!
  if (nameNode) {
    // Never reached
  }
}
```

### After (fixed)
```typescript
else if (node.type === 'using_directive') {
  // Using directives can have either an identifier or qualified_name as direct child
  let source = '';
  for (const child of node.children) {
    if (child.type === 'identifier' || child.type === 'qualified_name') {
      source = code.slice(child.startIndex, child.endIndex);
      break;
    }
  }
  if (source) {
    imports.push({...});
  }
}
```

---

## Bug 2: Order-Dependent Edge Creation

### Issue
When files were indexed in a certain order (importing file before exporting file), cross-file edges were not created. For example, if `consumer.ts` imports `getMCPResourceEnrichmentService` from `mcp-service.ts`, but `consumer.ts` was indexed first, no edge would be created because the target node didn't exist yet.

### Root Cause
The indexer created edges immediately during single-file indexing. If the target file's nodes hadn't been created yet, the edge lookup would fail silently.

### Fix: Two-Pass Indexing
Modified `src/indexer/indexer.ts` to use a two-pass approach during workspace indexing:

1. **Pass 1**: Parse all files and create nodes only (defer edge creation)
2. **Pass 2**: Create edges after all nodes exist

```typescript
// PASS 1: Parse files and create nodes (defer edge creation)
for (const file of files) {
  await this.indexFile(file, true); // deferEdges = true
}

// PASS 2: Create edges now that all nodes exist
this.createDeferredEdges();
```

### Impact
This ensures that:
- `export const fn = () => ...` functions are properly linked when imported
- Static method calls like `ClassName.getInstance()` create edges even if ClassName is in a file indexed later
- All cross-file references work regardless of file indexing order

---

## Test Coverage

New unit tests were added in `test/indexer/exported-symbol-detection.test.ts` covering:
- TypeScript named, default, namespace, and mixed imports
- TypeScript call site detection for imported symbols
- Const arrow function exports (e.g., `export const fn = () => ...`)
- C# using directive parsing (regular and static)
- C# constructor and static method call detection
- Symbol export detection for both TypeScript and C#
- Cross-file reference scenarios

## Date
2025-12-14

