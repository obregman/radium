import * as assert from 'assert';
import { extractSymbolsWithRegex } from '../../src/indexer/utils/regex-fallback';

suite('Regex Fallback Test Suite', () => {
  test('should extract C# methods from .xaml.cs file', () => {
    const code = `
using System;
using System.Windows;

namespace MyApp
{
    public sealed partial class GameWindow : Window
    {
        public void InitializeGame()
        {
            Console.WriteLine("Start");
            RenderMap();
        }
        
        private void RenderMap()
        {
            // Render logic
        }
        
        public async Task LoadDataAsync()
        {
            await Task.Delay(1000);
        }
    }
}
`;

    const symbols = extractSymbolsWithRegex(code, 'GameWindow.xaml.cs');
    
    assert.ok(symbols.length > 0, 'Should extract symbols');
    
    const methodNames = symbols.filter(s => s.kind === 'method').map(s => s.name);
    assert.ok(methodNames.includes('InitializeGame'), 'Should find InitializeGame');
    assert.ok(methodNames.includes('RenderMap'), 'Should find RenderMap');
    assert.ok(methodNames.includes('LoadDataAsync'), 'Should find LoadDataAsync');
    
    console.log(`Found methods: ${methodNames.join(', ')}`);
  });

  test('should extract C# classes', () => {
    const code = `
namespace MyApp
{
    public class GameState
    {
        public int Score { get; set; }
    }
    
    public sealed partial class MainWindow : Window
    {
        public void DoSomething() { }
    }
}
`;

    const symbols = extractSymbolsWithRegex(code, 'Test.cs');
    
    const classNames = symbols.filter(s => s.kind === 'class').map(s => s.name);
    assert.ok(classNames.includes('GameState'), 'Should find GameState class');
    assert.ok(classNames.includes('MainWindow'), 'Should find MainWindow class');
    
    console.log(`Found classes: ${classNames.join(', ')}`);
  });

  test('should extract C# properties', () => {
    const code = `
public class Player
{
    public string Name { get; set; }
    public int Health { get; private set; }
    private int score { get; set; }
}
`;

    const symbols = extractSymbolsWithRegex(code, 'Player.cs');
    
    const propertyNames = symbols.filter(s => s.kind === 'property').map(s => s.name);
    assert.ok(propertyNames.includes('Name'), 'Should find Name property');
    assert.ok(propertyNames.includes('Health'), 'Should find Health property');
    
    console.log(`Found properties: ${propertyNames.join(', ')}`);
  });

  test('should calculate correct byte ranges for methods', () => {
    const code = `public class Test
{
    public void Method1()
    {
        Console.WriteLine("Method1");
    }
    
    public void Method2()
    {
        Console.WriteLine("Method2");
    }
}`;

    const symbols = extractSymbolsWithRegex(code, 'Test.cs');
    
    const methods = symbols.filter(s => s.kind === 'method');
    assert.strictEqual(methods.length, 2, 'Should find 2 methods');
    
    // Verify ranges don't overlap
    const method1 = methods.find(m => m.name === 'Method1');
    const method2 = methods.find(m => m.name === 'Method2');
    
    assert.ok(method1, 'Should find Method1');
    assert.ok(method2, 'Should find Method2');
    
    assert.ok(method1!.range.end <= method2!.range.start, 'Method ranges should not overlap');
    
    console.log(`Method1 range: ${method1!.range.start}-${method1!.range.end}`);
    console.log(`Method2 range: ${method2!.range.start}-${method2!.range.end}`);
  });

  test('should handle large C# files', () => {
    // Simulate a large file similar to GameWindow.xaml.cs
    let code = 'using System;\nusing System.Windows;\n\nnamespace MyApp\n{\n';
    code += '    public sealed partial class GameWindow : Window\n    {\n';
    
    // Add 100 methods
    for (let i = 1; i <= 100; i++) {
      code += `        public void Method${i}()\n        {\n            Console.WriteLine("Method${i}");\n        }\n\n`;
    }
    
    code += '    }\n}\n';
    
    const symbols = extractSymbolsWithRegex(code, 'GameWindow.xaml.cs');
    
    const methods = symbols.filter(s => s.kind === 'method');
    assert.strictEqual(methods.length, 100, 'Should find all 100 methods');
    
    console.log(`Successfully extracted ${methods.length} methods from large file`);
  });

  test('should work for TypeScript files', () => {
    const code = `
export function myFunction() {
  console.log("Hello");
}

export class MyClass {
  constructor() {}
}

export interface MyInterface {
  name: string;
}
`;

    const symbols = extractSymbolsWithRegex(code, 'test.ts');
    
    assert.ok(symbols.some(s => s.name === 'myFunction'), 'Should find function');
    assert.ok(symbols.some(s => s.name === 'MyClass'), 'Should find class');
    assert.ok(symbols.some(s => s.name === 'MyInterface'), 'Should find interface');
  });
});

