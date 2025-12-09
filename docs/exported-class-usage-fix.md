# Exported Class Usage Detection Fix

## Problem

The Files Map was miscalculating symbol usage outside the file. Specifically, it was not detecting exported class usage when:
1. Classes were instantiated with `new ClassName()` in other files
2. Classes were referenced through static method calls like `ClassName.getInstance()` in other files

### Root Cause

The issue was that **constructor calls were not being detected** by the parsers. When code like `new MyClass()` was written:

1. The TypeScript/C# parsers were only detecting regular function calls (`call_expression` / `invocation_expression`)
2. Constructor calls use a different AST node type (`new_expression` / `object_creation_expression`)
3. Without detecting these constructor calls, no edges were created from the calling code to the class node
4. The Files Map calculates exported symbols by counting cross-file edges pointing to symbols
5. Since no edges pointed to the class, it appeared as if the class had zero external usage

## Solution

### Changes Made

1. **TypeScript/JavaScript/TSX Parser** (`src/indexer/parsers/typescript-parser.ts`):
   - Added detection of `new_expression` nodes
   - Extracts the class name from the `constructor` field
   - Creates a call site with just the class name (no "new" prefix)

2. **C# Parser** (`src/indexer/parsers/csharp-parser.ts`):
   - Added detection of `object_creation_expression` nodes
   - Extracts the class name from the `type` field
   - Creates a call site with just the class name

3. **Indexer** (`src/indexer/indexer.ts`):
   - Enhanced call edge creation to handle static method calls (e.g., `ClassName.staticMethod`)
   - For static method calls, creates edges to **both** the class and the method
   - This ensures classes are counted as "used" even when only their static methods are called

### How It Works Now

#### Example 1: Constructor Calls

```typescript
// File: MyClass.ts
export class MyClass {
  doSomething() {
    return 'hello';
  }
}

// File: user.ts
import { MyClass } from './MyClass';

export function useMyClass() {
  const instance = new MyClass();  // ← Now detected as a call to MyClass
  return instance.doSomething();
}
```

**Before the fix:**
- Parser detected: 1 call (`instance.doSomething`)
- Edge created: `useMyClass` → `doSomething` method
- MyClass had 0 external usage

**After the fix:**
- Parser detected: 2 calls (`MyClass`, `instance.doSomething`)
- Edges created: 
  - `useMyClass` → `MyClass` class
  - `useMyClass` → `doSomething` method
- MyClass now shows 1 external usage

#### Example 2: Static Method Calls

```typescript
// File: WebContentExtractor.ts
export class WebContentExtractor {
  private static instance: WebContentExtractor;
  
  public static getInstance(): WebContentExtractor {
    if (!this.instance) {
      this.instance = new WebContentExtractor();
    }
    return this.instance;
  }
}

// File: WebSearchService.ts
import { WebContentExtractor } from './WebContentExtractor';

export class WebSearchService {
  private contentExtractor: WebContentExtractor;
  
  private constructor() {
    this.contentExtractor = WebContentExtractor.getInstance();  // ← Static method call
  }
}
```

**Before the fix:**
- Parser detected: 1 call (`WebContentExtractor.getInstance`)
- Edge created: `WebSearchService` → `getInstance` method only
- WebContentExtractor class had 0 external usage (marked grey)

**After the fix:**
- Parser detected: 1 call (`WebContentExtractor.getInstance`)
- Edges created:
  - `WebSearchService` → `WebContentExtractor` class
  - `WebSearchService` → `getInstance` method
- WebContentExtractor class now shows 1 external usage (properly colored)

### Files Map Calculation

The Files Map (`src/views/files-map-panel.ts`) calculates exported symbols using this logic:

```typescript
const fileExportedSymbols = new Map<string, Set<number>>();
for (const edge of allEdges) {
  const srcNode = allNodes.find(n => n.id === edge.src);
  const dstNode = allNodes.find(n => n.id === edge.dst);
  
  if (!srcNode || !dstNode) continue;
  if (srcNode.path === dstNode.path) continue; // Skip same-file references
  
  // Count unique symbols referenced from other files
  fileExportedSymbols.get(dstNode.path)!.add(dstNode.id!);
}
```

With constructor calls now creating edges to class nodes, classes that are instantiated in other files are correctly counted as exported/used symbols.

## Testing

Added comprehensive tests in `test/indexer/constructor-call-detection.test.ts`:

1. ✅ Detects `new ClassName()` as a call to the class
2. ✅ Detects method calls like `instance.doSomething()`
3. ✅ Handles multiple constructor calls in the same file

All 247 tests pass.

## Impact

- **Files Map**: Now correctly shows which classes are used outside their defining file
- **Visual Indicators**: File nodes in the graph will show accurate exported symbol counts
- **Color Coding**: Files with exported classes will be properly color-coded based on usage
- **Cross-file Dependencies**: Constructor calls create proper dependency edges between files

## Languages Supported

- ✅ TypeScript
- ✅ JavaScript
- ✅ TSX (React)
- ✅ C#
- ⚠️ Python (uses function calls, not `new` keyword - already working)
- ⚠️ Go (uses function calls for constructors - already working)

