# Bug Fixes - November 2025

## Bug #2: Symbol Box Exceeding File Container Bottom ✅ FIXED

### Problem
When a file had a single symbol box, the bottom of the symbol box would exceed the bottom of the file container box, causing visual overflow.

### Root Cause
The container height calculation was not accounting for the CSS border width. The `.file-container` has:
- `border: 2px solid` (2px top + 2px bottom = 4px total)
- `box-sizing: border-box`
- `padding: 40px 0 0 0`

When `box-sizing: border-box` is used, the specified height includes padding AND borders. However, the JavaScript calculation was only accounting for padding:

```javascript
// OLD (incorrect):
const finalHeight = packed.contentH + 40 + 3; // Missing 4px for borders
```

This meant the actual content area was 4px smaller than expected, causing symbols to overflow.

### Solution
Updated the container height calculation to include the border height:

```javascript
// NEW (correct):
const finalHeight = packed.contentH + 40 + 3 + 4; // 40px label + 3px bottom padding + 4px borders
```

### Files Changed
- `src/views/symbol-changes-panel.ts` (line 2250)
- `test/views/symbol-layout.test.ts` (updated test to match new formula)

### Verification
All layout tests pass with the new calculation. The container now provides exactly 7px of bottom padding (3px intended + 4px from border accounting), ensuring symbols never overflow.

---

## Bug #3: TSX Files Not Parsed Correctly ✅ FIXED

### Problem
TSX files were not being parsed correctly. Interfaces and functions in `.tsx` files were not being detected.

### Root Cause
There were three issues:

1. **Wrong Parser**: TSX files were using the TypeScript parser instead of the TSX parser
2. **Wrong Language Key**: The `getLanguage` method returned 'typescript' for `.tsx` files, but the parser map had a separate 'tsx' entry
3. **Missing Language Check**: The symbol extraction logic only ran for 'typescript' and 'javascript', not 'tsx'
4. **Export Statements**: Exported functions (common in TSX) were wrapped in `export_statement` nodes and not being extracted

### Solution

**1. Added TSX Parser** (lines 9, 57-59):
```typescript
const TSX = require('tree-sitter-typescript').tsx;

// TSX parser (separate from TypeScript for proper JSX support)
const tsxParser = new Parser();
tsxParser.setLanguage(TSX);
this.parsers.set('tsx', tsxParser);
```

**2. Fixed Language Detection** (line 91):
```typescript
'tsx': 'tsx',  // TSX files need the TSX parser for proper JSX support
```

**3. Added TSX to Extraction Logic** (line 205):
```typescript
if (lang === 'typescript' || lang === 'tsx' || lang === 'javascript') {
```

**4. Handle Export Statements** (lines 249-258):
```typescript
} else if (node.type === 'export_statement') {
  // Handle exported declarations (common in TSX/TS files)
  const declarationNode = node.childForFieldName('declaration');
  if (declarationNode) {
    this.extractTypeScriptSymbols(declarationNode, code, symbols, imports, calls, filePath, namespace);
  }
  return;
}
```

### Files Changed
- `src/indexer/parser.ts` (lines 9, 57-59, 91, 205, 249-258)
- `test/indexer/parser.test.ts` (line 143): Updated test to expect 'tsx' for `.tsx` files

### Verification
All tests pass. TSX files now correctly detect:
- ✅ Interfaces
- ✅ Exported functions
- ✅ Classes
- ✅ Types

---

## Bug #1: Interface Changes Not Detected ⚠️ PARSER WORKS - ISSUE IS ELSEWHERE

### Investigation Status
Comprehensive testing confirms:
1. ✅ The parser correctly detects interfaces in both `.ts` and `.tsx` files
2. ✅ Interface symbols are extracted with `kind: 'interface'`
3. ✅ Modified interfaces are still detected after changes
4. ✅ TSX files with JSX syntax are parsed correctly

### Example Interface (from user report)
```typescript
interface Preset {
  id: string;
  name: string;
  content: string;
  description?: string;
  tags?: string[];
  createdAt: Date;
  updatedAt: Date;
}
```

This interface **IS** detected by the parser when tested in isolation.

### Root Cause Analysis
The issue is **NOT** with the parser. The interface is being detected, but it's not appearing in the Symbol Changes visualization. This means the problem is in one of these areas:

1. **Diff Analysis** (`analyzeDiffForSymbols` method):
   - The git diff might not be capturing the interface changes correctly
   - The line number mapping might be off
   - The changed lines might not be intersecting with the interface's byte range

2. **Symbol-to-Line Mapping** (lines 593-613):
   - The interface might not be identified as the "most specific symbol" for the changed lines
   - If properties are added/removed, the changed lines might be mapped to a different symbol

3. **Change Amount Calculation** (lines 690-730):
   - If the change amount is calculated as 0, the symbol won't be shown
   - The interface might be detected but with no changes attributed to it

4. **Noise Filtering** (lines 529-540):
   - Interface property additions might be classified as "noise" if they're just type annotations

### Debug Logging Added ✅
Added comprehensive logging to help diagnose the issue:
- Line 618: Logs all symbols detected by the parser
- Line 622: Logs which symbols will be processed based on changed lines

### How to Diagnose When It Happens Again

When you encounter this issue, check the **Radium Output Panel** for these log messages:

1. **Parser Detection**:
   ```
   All symbols detected: interface:Preset, function:PresetCard, ...
   ```
   If the interface appears here, the parser is working.

2. **Symbol Processing**:
   ```
   Symbols to process (2): interface:Preset, function:PresetCard
   ```
   If the interface is missing here, it means no changed lines were mapped to it.

3. **Line Mapping**:
   ```
   Line to symbol mapping: 5 -> Preset (interface), 12 -> PresetCard (function)
   ```
   This shows which lines were changed and which symbols they map to.

### Likely Scenarios

**Scenario A: Interface detected but not processed**
- The changed lines don't intersect with the interface's byte range
- **Solution**: The interface declaration line itself needs to change, or lines within the interface body

**Scenario B: Interface processed but change amount = 0**
- The diff shows changes but they're not being counted
- **Solution**: Check if changes are being filtered as "noise"

**Scenario C: Interface not the "most specific" symbol**
- Another symbol (like a nested type) is considered more specific
- **Solution**: Review the symbol hierarchy logic

### Files Modified for Debugging
- `src/views/symbol-changes-panel.ts` (lines 617-622): Added debug logging

### Recommendation
Next time this happens, please share:
1. The Radium Output Panel logs
2. The git diff for the file
3. The full file content (if possible)

This will help identify which of the above scenarios is occurring.

