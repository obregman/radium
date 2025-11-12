import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { CodeParser } from '../../src/indexer/parser';

/**
 * Test to verify that changes in .xaml.cs files are correctly mapped to functions
 * This simulates the real-world scenario where a change inside a method should
 * be attributed to that method, not to the FILE level
 */
suite('.xaml.cs Function Mapping Test Suite', () => {
  let parser: CodeParser;
  let tempDir: string;

  setup(() => {
    parser = new CodeParser();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radium-xaml-test-'));
  });

  teardown(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  /**
   * Helper function to convert byte offset to line number
   * This mimics what symbol-changes-panel.ts does
   */
  function byteOffsetToLineNumber(content: string, byteOffset: number): number {
    let lineCount = 1;
    for (let i = 0; i < Math.min(byteOffset, content.length); i++) {
      if (content[i] === '\n') {
        lineCount++;
      }
    }
    return lineCount;
  }

  test('should map changes inside InitializeGame to the function, not FILE', async () => {
    const originalCode = [
      'using System;',
      'using System.Windows;',
      '',
      'namespace MyGame',
      '{',
      '    public sealed partial class GameWindow : Window',
      '    {',
      '        public void InitializeGame()',
      '        {',
      '            Console.WriteLine("Start");',
      '            RenderMap();',
      '        }',
      '        ',
      '        private void RenderMap()',
      '        {',
      '            // Render logic',
      '        }',
      '    }',
      '}'
    ].join('\r\n'); // Windows CRLF

    const modifiedCode = [
      'using System;',
      'using System.Windows;',
      '',
      'namespace MyGame',
      '{',
      '    public sealed partial class GameWindow : Window',
      '    {',
      '        public void InitializeGame()',
      '        {',
      '            Console.WriteLine("Start");',
      '            RenderMap();',
      '            UpdateUI();  // NEW LINE ADDED',
      '        }',
      '        ',
      '        private void RenderMap()',
      '        {',
      '            // Render logic',
      '        }',
      '    }',
      '}'
    ].join('\r\n');

    // Write to temp file
    const testFile = path.join(tempDir, 'GameWindow.xaml.cs');
    fs.writeFileSync(testFile, modifiedCode, 'utf8');

    // Parse the modified code
    const result = await parser.parseFile(testFile, modifiedCode);
    
    assert.ok(result, 'Should parse .xaml.cs file');
    assert.ok(result!.symbols.length > 0, 'Should find symbols');

    // Find InitializeGame method
    const initMethod = result!.symbols.find(s => s.name === 'InitializeGame');
    assert.ok(initMethod, 'Should find InitializeGame method');

    // Convert byte ranges to line numbers
    const initStartLine = byteOffsetToLineNumber(modifiedCode, initMethod!.range.start);
    const initEndLine = byteOffsetToLineNumber(modifiedCode, initMethod!.range.end);

    console.log(`InitializeGame method spans lines ${initStartLine}-${initEndLine}`);
    console.log(`InitializeGame byte range: ${initMethod!.range.start}-${initMethod!.range.end}`);

    // The changed line is line 12 (where UpdateUI() was added)
    const changedLine = 12;

    // Verify that the changed line is within the method's range
    assert.ok(
      changedLine >= initStartLine && changedLine <= initEndLine,
      `Changed line ${changedLine} should be within InitializeGame (lines ${initStartLine}-${initEndLine})`
    );

    // Verify the method is detected with correct FQN
    assert.ok(
      initMethod!.fqname.includes('InitializeGame'),
      `FQN should include method name: ${initMethod!.fqname}`
    );
  });

  test('should map changes in lambda expression to containing method', async () => {
    const code = [
      'using System;',
      'using System.Windows;',
      'using System.Windows.Threading;',
      '',
      'namespace MyGame',
      '{',
      '    public sealed partial class GameWindow : Window',
      '    {',
      '        public void InitializeGame()',
      '        {',
      '            Dispatcher.InvokeAsync(() =>',
      '            {',
      '                RenderMap();',
      '                UpdateUI();',
      '                Console.WriteLine("Done");  // Line 15 - inside lambda',
      '            });',
      '        }',
      '        ',
      '        private void RenderMap() { }',
      '        private void UpdateUI() { }',
      '    }',
      '}'
    ].join('\r\n');

    const testFile = path.join(tempDir, 'GameWindow.xaml.cs');
    fs.writeFileSync(testFile, code, 'utf8');

    const result = await parser.parseFile(testFile, code);
    
    assert.ok(result, 'Should parse file');

    const initMethod = result!.symbols.find(s => s.name === 'InitializeGame');
    assert.ok(initMethod, 'Should find InitializeGame');

    // Convert to line numbers
    const initStartLine = byteOffsetToLineNumber(code, initMethod!.range.start);
    const initEndLine = byteOffsetToLineNumber(code, initMethod!.range.end);

    console.log(`InitializeGame with lambda spans lines ${initStartLine}-${initEndLine}`);

    // Line 15 is inside the lambda, which is inside InitializeGame
    const changedLine = 15;

    assert.ok(
      changedLine >= initStartLine && changedLine <= initEndLine,
      `Line ${changedLine} (inside lambda) should be within InitializeGame (lines ${initStartLine}-${initEndLine})`
    );
  });

  test('should correctly identify method boundaries with multiple methods', async () => {
    const code = [
      'using System;',
      'using System.Windows;',
      '',
      'namespace MyApp',
      '{',
      '    public partial class MainWindow : Window',
      '    {',
      '        public void Method1()',  // Line 8
      '        {',
      '            Console.WriteLine("Method1");',  // Line 10
      '        }',
      '        ',
      '        public void Method2()',  // Line 13
      '        {',
      '            Console.WriteLine("Method2");',  // Line 15
      '        }',
      '        ',
      '        public void Method3()',  // Line 18
      '        {',
      '            Console.WriteLine("Method3");',  // Line 20
      '        }',
      '    }',
      '}'
    ].join('\r\n');

    const testFile = path.join(tempDir, 'MainWindow.xaml.cs');
    fs.writeFileSync(testFile, code, 'utf8');

    const result = await parser.parseFile(testFile, code);
    
    assert.ok(result, 'Should parse file');

    const method1 = result!.symbols.find(s => s.name === 'Method1');
    const method2 = result!.symbols.find(s => s.name === 'Method2');
    const method3 = result!.symbols.find(s => s.name === 'Method3');

    assert.ok(method1, 'Should find Method1');
    assert.ok(method2, 'Should find Method2');
    assert.ok(method3, 'Should find Method3');

    // Convert to line numbers
    const method1Start = byteOffsetToLineNumber(code, method1!.range.start);
    const method1End = byteOffsetToLineNumber(code, method1!.range.end);
    const method2Start = byteOffsetToLineNumber(code, method2!.range.start);
    const method2End = byteOffsetToLineNumber(code, method2!.range.end);
    const method3Start = byteOffsetToLineNumber(code, method3!.range.start);
    const method3End = byteOffsetToLineNumber(code, method3!.range.end);

    console.log(`Method1: lines ${method1Start}-${method1End}`);
    console.log(`Method2: lines ${method2Start}-${method2End}`);
    console.log(`Method3: lines ${method3Start}-${method3End}`);

    // Verify line 10 is in Method1
    assert.ok(10 >= method1Start && 10 <= method1End, 'Line 10 should be in Method1');
    assert.ok(!(10 >= method2Start && 10 <= method2End), 'Line 10 should NOT be in Method2');
    assert.ok(!(10 >= method3Start && 10 <= method3End), 'Line 10 should NOT be in Method3');

    // Verify line 15 is in Method2
    assert.ok(!(15 >= method1Start && 15 <= method1End), 'Line 15 should NOT be in Method1');
    assert.ok(15 >= method2Start && 15 <= method2End, 'Line 15 should be in Method2');
    assert.ok(!(15 >= method3Start && 15 <= method3End), 'Line 15 should NOT be in Method3');

    // Verify line 20 is in Method3
    assert.ok(!(20 >= method1Start && 20 <= method1End), 'Line 20 should NOT be in Method1');
    assert.ok(!(20 >= method2Start && 20 <= method2End), 'Line 20 should NOT be in Method2');
    assert.ok(20 >= method3Start && 20 <= method3End, 'Line 20 should be in Method3');
  });

  test('should handle edge case: change on method declaration line', async () => {
    const code = [
      'using System;',
      '',
      'public class Test',
      '{',
      '    public void MyMethod(string param)  // Line 5 - method declaration',
      '    {',
      '        Console.WriteLine(param);',
      '    }',
      '}'
    ].join('\r\n');

    const testFile = path.join(tempDir, 'Test.cs');
    fs.writeFileSync(testFile, code, 'utf8');

    const result = await parser.parseFile(testFile, code);
    
    assert.ok(result, 'Should parse file');

    const method = result!.symbols.find(s => s.name === 'MyMethod');
    assert.ok(method, 'Should find MyMethod');

    const methodStart = byteOffsetToLineNumber(code, method!.range.start);
    const methodEnd = byteOffsetToLineNumber(code, method!.range.end);

    console.log(`MyMethod spans lines ${methodStart}-${methodEnd}`);

    // Line 5 is the method declaration line - should be included in the method range
    assert.ok(
      5 >= methodStart && 5 <= methodEnd,
      `Method declaration line (5) should be within method range (${methodStart}-${methodEnd})`
    );
  });
});

