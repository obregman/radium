import * as assert from 'assert';
import { CodeParser } from '../../src/indexer/parser';

suite('Windows Line Endings Test Suite', () => {
  let parser: CodeParser;

  setup(() => {
    parser = new CodeParser();
  });

  test('should handle CRLF line endings in .xaml.cs files', async () => {
    // Code with Windows CRLF line endings (\r\n)
    const code = [
      'using System;',
      'using System.Windows;',
      '',
      'namespace MyApp',
      '{',
      '    public partial class MainWindow : Window',
      '    {',
      '        public MainWindow()',
      '        {',
      '            InitializeComponent();',
      '        }',
      '        ',
      '        private void OnButtonClick(object sender, RoutedEventArgs e)',
      '        {',
      '            Console.WriteLine("Hello");',
      '        }',
      '    }',
      '}'
    ].join('\r\n'); // Windows line endings

    const result = await parser.parseFile('MainWindow.xaml.cs', code);
    
    assert.ok(result, 'Should parse file with CRLF line endings');
    assert.ok(result!.symbols.length > 0, 'Should find symbols');
    
    const mainWindow = result!.symbols.find(s => s.name === 'MainWindow' && s.kind === 'class');
    assert.ok(mainWindow, 'Should find MainWindow class');
    
    const constructor = result!.symbols.find(s => s.name === 'MainWindow' && s.kind === 'constructor');
    assert.ok(constructor, 'Should find constructor');
    
    const method = result!.symbols.find(s => s.name === 'OnButtonClick');
    assert.ok(method, 'Should find OnButtonClick method');
    
    // Verify byte ranges are correct
    assert.ok(method!.range.start > 0, 'Method should have valid start range');
    assert.ok(method!.range.end > method!.range.start, 'Method should have valid end range');
    
    // Log the ranges for debugging
    console.log('MainWindow class range:', mainWindow!.range);
    console.log('Constructor range:', constructor!.range);
    console.log('OnButtonClick range:', method!.range);
    
    // Verify the method is within the class
    assert.ok(
      method!.range.start >= mainWindow!.range.start && method!.range.end <= mainWindow!.range.end,
      'Method should be within class range'
    );
  });

  test('should correctly map byte offsets to line numbers with CRLF', async () => {
    const code = [
      'using System;',
      '',
      'public class Test',
      '{',
      '    public void Method1()',
      '    {',
      '        Console.WriteLine("Line 7");',
      '    }',
      '    ',
      '    public void Method2()',
      '    {',
      '        Console.WriteLine("Line 12");',
      '    }',
      '}'
    ].join('\r\n');

    const result = await parser.parseFile('Test.cs', code);
    
    assert.ok(result, 'Should parse file');
    
    const method1 = result!.symbols.find(s => s.name === 'Method1');
    const method2 = result!.symbols.find(s => s.name === 'Method2');
    
    assert.ok(method1, 'Should find Method1');
    assert.ok(method2, 'Should find Method2');
    
    // Method2 should start after Method1 ends
    assert.ok(
      method2!.range.start > method1!.range.end,
      `Method2 start (${method2!.range.start}) should be after Method1 end (${method1!.range.end})`
    );
    
    console.log('Method1 range:', method1!.range);
    console.log('Method2 range:', method2!.range);
  });

  test('should handle mixed LF and CRLF line endings', async () => {
    // Some editors might create mixed line endings
    const code = 'using System;\r\n' +
                 'using System.Windows;\n' +  // LF here
                 '\r\n' +
                 'public class Mixed\r\n' +
                 '{\r\n' +
                 '    public void Test()\n' +  // LF here
                 '    {\r\n' +
                 '        Console.WriteLine("Test");\r\n' +
                 '    }\r\n' +
                 '}';

    const result = await parser.parseFile('Mixed.cs', code);
    
    assert.ok(result, 'Should parse file with mixed line endings');
    
    const testMethod = result!.symbols.find(s => s.name === 'Test');
    assert.ok(testMethod, 'Should find Test method even with mixed line endings');
    
    console.log('Test method range:', testMethod!.range);
  });
});

