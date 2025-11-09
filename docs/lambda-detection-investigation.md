# Lambda Expression Change Detection Investigation

## Issue Report
User reported that changes inside lambda blocks in `.xaml.cs` files are not being detected.

Example code:
```csharp
Dispatcher.InvokeAsync(async () =>
{
    await Task.Delay(50);
    RenderMap();
    UpdateUI();
    _engine.InitializeAI();
    UpdatePausePlayButton(); // Changes here might not be detected
}, System.Windows.Threading.DispatcherPriority.Background);
```

## Investigation Results

### ✅ Parser Works Correctly
Tests confirm that the C# parser **correctly** detects:
1. Methods containing lambda expressions
2. The full range of methods including lambda bodies
3. All symbols in `.xaml.cs` files

Test results show:
- `InitializeGame` method is detected with correct byte ranges
- Changes inside lambda expressions fall within the method's line range
- The parser handles `sealed partial class` declarations properly

### ✅ File Watching Works
- `.xaml.cs` files are correctly identified as source files (they end with `.cs`)
- Chokidar watcher is configured to watch all files in the workspace
- No special exclusions that would prevent `.xaml.cs` from being watched

### Possible Root Causes

The issue is likely one of the following:

1. **Caching Issue**: The diff cache might be serving stale diffs
2. **Baseline State**: The file's baseline state might not be set correctly
3. **Line Number Calculation**: Edge case in byte-offset-to-line-number conversion
4. **Debouncing**: Rapid saves might cause changes to be skipped
5. **Diff Parsing**: The git diff for the file might not be parsed correctly

## Enhanced Logging Added

Added comprehensive logging specifically for C# files with lambda expressions:

### Detection Logging
```typescript
[XAML.CS] Processing file: GameWindow.xaml.cs
[C#] File contains lambda expressions (=>)
[C#] Lambda count: 3
```

### Symbol Detection Logging
```typescript
[C#] All symbols detected: function:InitializeGame (lines 6-16), function:RenderMap (lines 18-22)
```

### Line Matching Logging
```typescript
[C#] Changed line numbers: 10, 11, 14
[C#] Line 10 matched to symbol: InitializeGame (function)
[C#] Line 11 matched to symbol: InitializeGame (function)
[C#] Line 14 matched to symbol: InitializeGame (function)
```

### Warning Logging
```typescript
[C#] WARNING: Line 14 did not match any symbol!
```

## How to Diagnose

When the issue occurs:

1. **Open Output Panel**: View → Output → Select "Radium Symbol Changes"
2. **Make a change** inside a lambda expression in a `.xaml.cs` file
3. **Look for the logs** with `[C#]` or `[XAML.CS]` prefixes
4. **Check for**:
   - Are symbols being detected? Look for "All symbols detected"
   - Are changed lines being identified? Look for "Changed line numbers"
   - Are lines matching to symbols? Look for "Line X matched to symbol"
   - Any warnings? Look for "WARNING: Line X did not match any symbol"

## Test Cases Added

### Test: `should detect methods containing lambda expressions`
Verifies that methods with lambda expressions are correctly parsed.

### Test: `should detect changes inside lambda expressions in C# methods`
Simulates a real change scenario:
- Original code without `UpdatePausePlayButton()`
- Modified code with the line added
- Verifies the method range includes the change
- Confirms line numbers are calculated correctly

### Test: `should detect method when changes are inside nested lambda`
Tests deeply nested lambda scenarios.

## Next Steps

If the issue persists after these logging improvements:

1. **Collect Logs**: Reproduce the issue and collect the output from "Radium Symbol Changes"
2. **Check Patterns**:
   - Does it happen only on first save after opening?
   - Does it happen only for specific methods?
   - Does closing and reopening the file help?
3. **Verify File State**:
   - Check if the file is in `filesCreatedThisSession`
   - Check if baseline state is set correctly
   - Check if diff cache has stale data

## Workaround

If changes are not detected:
1. Close the Symbol Changes panel
2. Reopen it (this clears all caches)
3. Make the change again

## Files Modified

- `src/views/symbol-changes-panel.ts`: Added enhanced logging for C# lambda detection
- `test/indexer/csharp-parser.test.ts`: Added test for lambda expression detection
- `test/indexer/lambda-change-detection.test.ts`: Added comprehensive change detection tests

