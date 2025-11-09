import * as assert from 'assert';
import { CodeParser } from '../../src/indexer/parser';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

suite('Lambda Change Detection Test Suite', () => {
  let parser: CodeParser;
  let tempDir: string;

  setup(() => {
    parser = new CodeParser();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radium-test-'));
  });

  teardown(() => {
    // Clean up temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('should detect changes inside lambda expressions in C# methods', async () => {
    const originalCode = `using System;
using System.Windows.Threading;

public sealed partial class GameWindow : Window
{
    public void InitializeGame()
    {
        Dispatcher.InvokeAsync(async () =>
        {
            await Task.Delay(50);
            RenderMap();
            UpdateUI();
            _engine.InitializeAI();
        }, System.Windows.Threading.DispatcherPriority.Background);
    }
    
    private void RenderMap()
    {
        // Render logic
    }
    
    private void UpdateUI()
    {
        // UI update logic
    }
}`;

    const modifiedCode = `using System;
using System.Windows.Threading;

public sealed partial class GameWindow : Window
{
    public void InitializeGame()
    {
        Dispatcher.InvokeAsync(async () =>
        {
            await Task.Delay(50);
            RenderMap();
            UpdateUI();
            _engine.InitializeAI();
            UpdatePausePlayButton(); // NEW LINE ADDED
        }, System.Windows.Threading.DispatcherPriority.Background);
    }
    
    private void RenderMap()
    {
        // Render logic
    }
    
    private void UpdateUI()
    {
        // UI update logic
    }
}`;

    // Write original file
    const testFile = path.join(tempDir, 'GameWindow.xaml.cs');
    fs.writeFileSync(testFile, originalCode, 'utf8');

    // Parse original
    const originalResult = await parser.parseFile(testFile, originalCode);
    assert.ok(originalResult, 'Should parse original file');
    
    console.log('Original symbols:', originalResult!.symbols.map(s => `${s.kind}:${s.name} (${s.range.start}-${s.range.end})`));

    // Parse modified
    const modifiedResult = await parser.parseFile(testFile, modifiedCode);
    assert.ok(modifiedResult, 'Should parse modified file');
    
    console.log('Modified symbols:', modifiedResult!.symbols.map(s => `${s.kind}:${s.name} (${s.range.start}-${s.range.end})`));

    // Find InitializeGame method in both versions
    const originalInit = originalResult!.symbols.find(s => s.kind === 'function' && s.name === 'InitializeGame');
    const modifiedInit = modifiedResult!.symbols.find(s => s.kind === 'function' && s.name === 'InitializeGame');

    assert.ok(originalInit, 'Should find InitializeGame in original');
    assert.ok(modifiedInit, 'Should find InitializeGame in modified');

    console.log('Original InitializeGame range:', originalInit!.range);
    console.log('Modified InitializeGame range:', modifiedInit!.range);

    // The modified version should have a larger end range (more bytes)
    assert.ok(modifiedInit!.range.end > originalInit!.range.end, 
      `Modified method should be larger. Original: ${originalInit!.range.end}, Modified: ${modifiedInit!.range.end}`);

    // Now simulate what the change detection does:
    // 1. Calculate line numbers for the change
    const changedLineNumber = 14; // The line where UpdatePausePlayButton() was added

    // 2. Convert byte offsets to line numbers
    const originalInitStartLine = getLineNumber(originalCode, originalInit!.range.start);
    const originalInitEndLine = getLineNumber(originalCode, originalInit!.range.end);
    const modifiedInitStartLine = getLineNumber(modifiedCode, modifiedInit!.range.start);
    const modifiedInitEndLine = getLineNumber(modifiedCode, modifiedInit!.range.end);

    console.log(`Original InitializeGame lines: ${originalInitStartLine}-${originalInitEndLine}`);
    console.log(`Modified InitializeGame lines: ${modifiedInitStartLine}-${modifiedInitEndLine}`);
    console.log(`Changed line: ${changedLineNumber}`);

    // The changed line should be within the method's range
    assert.ok(changedLineNumber >= modifiedInitStartLine && changedLineNumber <= modifiedInitEndLine,
      `Changed line ${changedLineNumber} should be within method range ${modifiedInitStartLine}-${modifiedInitEndLine}`);
  });

  test('should detect method when changes are inside nested lambda', async () => {
    const code = `using System;

public class TestClass
{
    public void OuterMethod()
    {
        SomeCall(() => 
        {
            // Change happens here
            DoSomething();
        });
    }
}`;

    const testFile = path.join(tempDir, 'Test.cs');
    fs.writeFileSync(testFile, code, 'utf8');

    const result = await parser.parseFile(testFile, code);
    assert.ok(result, 'Should parse file');

    const method = result!.symbols.find(s => s.kind === 'function' && s.name === 'OuterMethod');
    assert.ok(method, 'Should find OuterMethod');

    // The method should span the entire block including the lambda
    const methodStartLine = getLineNumber(code, method!.range.start);
    const methodEndLine = getLineNumber(code, method!.range.end);

    console.log(`OuterMethod spans lines ${methodStartLine}-${methodEndLine}`);

    // Line 10 (DoSomething()) should be within the method
    const changeLineNumber = 10;
    assert.ok(changeLineNumber >= methodStartLine && changeLineNumber <= methodEndLine,
      `Change at line ${changeLineNumber} should be within method range ${methodStartLine}-${methodEndLine}`);
  });
});

function getLineNumber(content: string, byteOffset: number): number {
  const lines = content.substring(0, byteOffset).split('\n');
  return lines.length;
}

