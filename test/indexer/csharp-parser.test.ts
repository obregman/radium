import * as assert from 'assert';
import { CodeParser } from '../../src/indexer/parser';

suite('C# Parser Test Suite', () => {
  let parser: CodeParser;

  setup(() => {
    parser = new CodeParser();
  });

  test('should detect C# constructors', async () => {
    const code = `
using System;

namespace MyApp
{
    public class MyClass
    {
        private string name;
        
        public MyClass(string name)
        {
            this.name = name;
        }
        
        public void DoSomething()
        {
            Console.WriteLine(name);
        }
    }
}`;
    
    const result = await parser.parseFile('test.cs', code);
    
    assert.ok(result, 'Should return parse result');
    assert.ok(result!.symbols.length > 0, 'Should find symbols');
    
    // Find the constructor
    const constructor = result!.symbols.find(s => s.kind === 'constructor');
    assert.ok(constructor, 'Should find constructor');
    assert.strictEqual(constructor!.name, 'MyClass', 'Constructor name should be MyClass');
    
    // Find the method
    const method = result!.symbols.find(s => s.kind === 'function' && s.name === 'DoSomething');
    assert.ok(method, 'Should find method');
    
    // Find the class
    const classSymbol = result!.symbols.find(s => s.kind === 'class');
    assert.ok(classSymbol, 'Should find class');
    assert.strictEqual(classSymbol!.name, 'MyClass', 'Class name should be MyClass');
  });

  test('should detect multiple constructors (overloading)', async () => {
    const code = `
namespace MyApp
{
    public class Person
    {
        private string firstName;
        private string lastName;
        
        public Person()
        {
            firstName = "Unknown";
            lastName = "Unknown";
        }
        
        public Person(string first, string last)
        {
            firstName = first;
            lastName = last;
        }
    }
}`;
    
    const result = await parser.parseFile('test.cs', code);
    
    assert.ok(result, 'Should return parse result');
    
    // Debug: log all symbols found
    console.log('All symbols found:', result!.symbols.map(s => `${s.kind}:${s.name}`));
    
    // Find all constructors
    const constructors = result!.symbols.filter(s => s.kind === 'constructor');
    console.log('Constructors found:', constructors.map(c => `${c.kind}:${c.name}`));
    
    assert.ok(constructors.length >= 2, `Should find at least 2 constructors, found ${constructors.length}`);
    assert.ok(constructors.every(c => c.name === 'Person'), 'All constructors should be named Person');
  });

  test('should detect static constructors', async () => {
    const code = `
namespace MyApp
{
    public class Config
    {
        private static string defaultValue;
        
        static Config()
        {
            defaultValue = "default";
        }
        
        public Config()
        {
            // Instance constructor
        }
    }
}`;
    
    const result = await parser.parseFile('test.cs', code);
    
    assert.ok(result, 'Should return parse result');
    
    // Find all constructors (both static and instance)
    const constructors = result!.symbols.filter(s => s.kind === 'constructor');
    assert.ok(constructors.length >= 1, 'Should find at least 1 constructor');
  });

  test('should parse .xaml.cs files with Windows paths', async () => {
    const code = `
using System;

namespace MyApp
{
    public partial class MainPage
    {
        public MainPage()
        {
            InitializeComponent();
        }
        
        private void OnButtonClicked(object sender, EventArgs e)
        {
            Console.WriteLine("Button clicked");
        }
    }
}`;
    
    // Test with Windows-style path
    const result = await parser.parseFile('C:\\Users\\Project\\MainPage.xaml.cs', code);
    
    assert.ok(result, 'Should return parse result for Windows .xaml.cs file');
    assert.ok(result!.symbols.length > 0, 'Should find symbols in Windows .xaml.cs file');
    
    const constructor = result!.symbols.find(s => s.kind === 'constructor');
    assert.ok(constructor, 'Should find constructor in Windows .xaml.cs file');
    
    const methods = result!.symbols.filter(s => s.kind === 'function');
    assert.ok(methods.length >= 1, `Should find at least 1 method, found ${methods.length}`);
  });

  test('should parse .xaml.cs files (compound extension)', async () => {
    const code = `
using System;

namespace MyApp
{
    public partial class MainPage
    {
        public MainPage()
        {
            InitializeComponent();
        }
        
        private void OnButtonClicked(object sender, EventArgs e)
        {
            Console.WriteLine("Button clicked");
        }
        
        public void UpdateUI()
        {
            // Update UI logic
        }
    }
}`;
    
    // Test with .xaml.cs extension
    const result = await parser.parseFile('MainPage.xaml.cs', code);
    
    assert.ok(result, 'Should return parse result for .xaml.cs file');
    assert.ok(result!.symbols.length > 0, 'Should find symbols in .xaml.cs file');
    
    // Find the constructor
    const constructor = result!.symbols.find(s => s.kind === 'constructor');
    assert.ok(constructor, 'Should find constructor in .xaml.cs file');
    assert.strictEqual(constructor!.name, 'MainPage', 'Constructor name should be MainPage');
    
    // Find the methods
    const methods = result!.symbols.filter(s => s.kind === 'function');
    assert.ok(methods.length >= 2, `Should find at least 2 methods, found ${methods.length}`);
    
    const onButtonClicked = methods.find(m => m.name === 'OnButtonClicked');
    assert.ok(onButtonClicked, 'Should find OnButtonClicked method');
    
    const updateUI = methods.find(m => m.name === 'UpdateUI');
    assert.ok(updateUI, 'Should find UpdateUI method');
    
    // Find the class
    const classSymbol = result!.symbols.find(s => s.kind === 'class');
    assert.ok(classSymbol, 'Should find class in .xaml.cs file');
    assert.strictEqual(classSymbol!.name, 'MainPage', 'Class name should be MainPage');
  });

  test('should detect methods, properties, and fields in C# classes', async () => {
    const code = `
namespace MyApp
{
    public class Employee
    {
        private int id;
        public string Name { get; set; }
        
        public Employee(int id, string name)
        {
            this.id = id;
            Name = name;
        }
        
        public void Work()
        {
            Console.WriteLine("Working...");
        }
        
        public int GetId()
        {
            return id;
        }
    }
}`;
    
    const result = await parser.parseFile('test.cs', code);
    
    assert.ok(result, 'Should return parse result');
    
    // Check for constructor
    const constructor = result!.symbols.find(s => s.kind === 'constructor');
    assert.ok(constructor, 'Should find constructor');
    
    // Check for methods
    const methods = result!.symbols.filter(s => s.kind === 'function');
    assert.ok(methods.length >= 2, 'Should find at least 2 methods');
    
    // Check for property
    const property = result!.symbols.find(s => s.kind === 'variable' && s.name === 'Name');
    assert.ok(property, 'Should find Name property');
  });
});

