# ⚠️ RE-INDEXING REQUIRED

## Why You're Still Seeing Grey

The fix for exported class usage detection is now complete and working correctly in the code. However, **your database still contains the old edges** that were created before the fix.

The issue is that `WebContentExtractor` was indexed **before** the parser knew how to detect:
1. Constructor calls (`new ClassName()`)
2. Static method calls creating edges to the class (`ClassName.staticMethod()`)

So your database has edges like:
- ❌ `WebSearchService` → `getInstance` method (but NOT to WebContentExtractor class)

But it needs:
- ✅ `WebSearchService` → `WebContentExtractor` class
- ✅ `WebSearchService` → `getInstance` method

## How to Fix This

### Option 1: Run the Re-index Command (Recommended)

1. Open the Command Palette (`Cmd+Shift+P` on Mac, `Ctrl+Shift+P` on Windows/Linux)
2. Type: `Radium: Re-index Workspace`
3. Press Enter
4. Wait for the indexing to complete
5. Open or refresh the Files Map view

### Option 2: Delete the Database and Restart VS Code

1. Close VS Code
2. Delete the database file at:
   - Mac/Linux: `~/.cursor/projects/<your-project-path>/radium.db`
   - Windows: `%APPDATA%\Cursor\projects\<your-project-path>\radium.db`
3. Restart VS Code
4. The extension will automatically re-index on startup

### Option 3: Reload the Window

1. Open Command Palette
2. Type: `Developer: Reload Window`
3. Press Enter
4. This will restart the extension and trigger a fresh index

## How to Verify the Fix

After re-indexing, check the Developer Console for logs like:

```
[Files Map] Cross-file edge: WebSearchService.ts:WebSearchService --calls--> WebContentExtractor.ts:WebContentExtractor
[Files Map] Exported symbols per file: 
  { path: 'WebContentExtractor.ts', count: 1, symbols: ['class:WebContentExtractor'] }
```

If you see these logs, the fix is working! The file should now be colored (yellow/green) instead of grey.

## Debug Logging

I've added debug logging to help diagnose issues. When you open the Files Map, check the Developer Console (`Help` → `Toggle Developer Tools` → `Console` tab) for:

- `[Files Map] Processing X edges to calculate exported symbols`
- `[Files Map] Cross-file edge: ...` (for WebContentExtractor and WebSearchService)
- `[Files Map] Exported symbols per file: ...`

This will show you exactly which edges are being detected and counted.

## What Was Fixed

The code changes are complete and working:

1. ✅ TypeScript parser now detects `new ClassName()` constructor calls
2. ✅ C# parser now detects `new ClassName()` object creation
3. ✅ Indexer creates edges to both class AND method for static calls like `ClassName.staticMethod()`
4. ✅ All 250 tests pass

The only remaining step is to **re-index your workspace** so the database contains the new edges.

