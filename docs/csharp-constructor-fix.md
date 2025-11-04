# C# Constructor Detection Fix

## Problem

When code was added to a C# constructor, Radium was categorizing it as a **FILE** change instead of detecting it as a **constructor** symbol change. This resulted in a generic file-level change notification rather than a specific symbol-level visualization.

## Root Cause

The C# parser (`extractCSharpSymbols` method in `src/indexer/parser.ts`) was missing support for `constructor_declaration` nodes from tree-sitter-c-sharp. 

The parser handled:
- `method_declaration` - regular methods ✅
- `class_declaration` - classes ✅
- `interface_declaration` - interfaces ✅
- `property_declaration` - properties ✅
- etc.

But **not** `constructor_declaration` - constructors ❌

When tree-sitter parsed a C# file with constructor changes, it returned zero symbols for the constructor. This triggered the fallback behavior in `analyzeDiffForSymbols` (line 363 of `symbol-changes-panel.ts`):

```typescript
// If no symbols detected, send a fallback "file changed" box
if (symbolChanges.symbols.length === 0) {
  // ... creates a generic FILE change
}
```

## Solution

### 1. Added Constructor Detection in Parser

Added a new condition in `extractCSharpSymbols` to handle `constructor_declaration` nodes:

```typescript
// Constructor declarations
else if (node.type === 'constructor_declaration') {
  const nameNode = node.childForFieldName('name');
  if (nameNode) {
    const name = code.slice(nameNode.startIndex, nameNode.endIndex);
    symbols.push({
      kind: 'constructor',
      name,
      fqname: namespace ? `${namespace}.${name}` : name,
      range: { start: node.startIndex, end: node.endIndex }
    });
  }
}
```

### 2. Updated Type Definitions

Updated the `SymbolChange` interface to include `'constructor'` as a valid symbol type:

```typescript
interface SymbolChange {
  type: 'function' | 'class' | 'method' | 'interface' | 'type' | 'variable' | 'constant' | 'constructor' | 'file';
  // ...
}
```

### 3. Added Comprehensive Tests

Created `test/indexer/csharp-parser.test.ts` with tests for:
- Basic constructor detection ✅
- Overloaded constructors (multiple constructors in same class) ✅
- Static constructors ✅
- Constructors alongside methods and properties ✅

## Results

- **Before**: Changes to C# constructors → Generic "FILE" change box
- **After**: Changes to C# constructors → Specific "CONSTRUCTOR" symbol box with proper visualization

All 40 tests pass, including 4 new C# constructor-specific tests.

## Files Changed

1. `src/indexer/parser.ts` - Added constructor detection
2. `src/views/symbol-changes-panel.ts` - Added 'constructor' to type union
3. `test/indexer/csharp-parser.test.ts` - New test file
4. `README.md` - Updated documentation
5. `CHANGELOG.md` - Documented the fix

## Testing

Run the C# parser tests:
```bash
npm test -- --grep "C# Parser"
```

All tests should pass with constructors properly detected.

