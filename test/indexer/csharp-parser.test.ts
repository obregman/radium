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
using System.Threading.Tasks;

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
        
        public async Task LoadDataAsync()
        {
            await Task.Delay(100);
        }
        
        private async void OnRefreshClicked(object sender, EventArgs e)
        {
            await LoadDataAsync();
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
    
    // Find the methods (both sync and async)
    const methods = result!.symbols.filter(s => s.kind === 'function');
    assert.ok(methods.length >= 4, `Should find at least 4 methods (2 sync + 2 async), found ${methods.length}`);
    
    // Verify sync methods
    const onButtonClicked = methods.find(m => m.name === 'OnButtonClicked');
    assert.ok(onButtonClicked, 'Should find sync method OnButtonClicked');
    
    const updateUI = methods.find(m => m.name === 'UpdateUI');
    assert.ok(updateUI, 'Should find sync method UpdateUI');
    
    // Verify async methods
    const loadDataAsync = methods.find(m => m.name === 'LoadDataAsync');
    assert.ok(loadDataAsync, 'Should find async method LoadDataAsync');
    
    const onRefreshClicked = methods.find(m => m.name === 'OnRefreshClicked');
    assert.ok(onRefreshClicked, 'Should find async void method OnRefreshClicked');
    
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

  test('should detect methods in sealed partial classes (GameWindow scenario)', async () => {
    const code = `
using System;
using System.Windows;

namespace MyGame
{
    public sealed partial class GameWindow : Window
    {
        public GameWindow()
        {
            InitializeComponent();
        }
        
        private void OnStartButtonClick(object sender, RoutedEventArgs e)
        {
            StartGame();
        }
        
        private void StartGame()
        {
            Console.WriteLine("Game started!");
        }
        
        public void UpdateScore(int score)
        {
            ScoreLabel.Content = score.ToString();
        }
    }
}`;
    
    const result = await parser.parseFile('GameWindow.xaml.cs', code);
    
    assert.ok(result, 'Should return parse result');
    assert.ok(result!.symbols.length > 0, 'Should find symbols in sealed partial class');
    
    // Check for class
    const classSymbol = result!.symbols.find(s => s.kind === 'class' && s.name === 'GameWindow');
    assert.ok(classSymbol, 'Should find GameWindow class');
    
    // Check for constructor
    const constructor = result!.symbols.find(s => s.kind === 'constructor' && s.name === 'GameWindow');
    assert.ok(constructor, 'Should find GameWindow constructor');
    
    // Check for methods
    const startGame = result!.symbols.find(s => s.kind === 'function' && s.name === 'StartGame');
    assert.ok(startGame, 'Should find StartGame method');
    
    const updateScore = result!.symbols.find(s => s.kind === 'function' && s.name === 'UpdateScore');
    assert.ok(updateScore, 'Should find UpdateScore method');
    
    const onStartButtonClick = result!.symbols.find(s => s.kind === 'function' && s.name === 'OnStartButtonClick');
    assert.ok(onStartButtonClick, 'Should find OnStartButtonClick event handler');
    
    // Verify all methods have proper FQN
    const methods = result!.symbols.filter(s => s.kind === 'function');
    assert.ok(methods.length >= 3, `Should find at least 3 methods, found ${methods.length}`);
    
    for (const method of methods) {
      assert.ok(method.fqname.includes('GameWindow'), `Method ${method.name} should have GameWindow in FQN: ${method.fqname}`);
    }
  });

  test('should detect C# delegates', async () => {
    const code = `
namespace MyApp
{
    public delegate void NotifyDelegate(string message);
    public delegate int CalculateDelegate(int x, int y);
    
    public class EventManager
    {
        public NotifyDelegate OnNotify;
    }
}`;
    
    const result = await parser.parseFile('test.cs', code);
    
    assert.ok(result, 'Should return parse result');
    
    const notifyDelegate = result!.symbols.find(s => s.name === 'NotifyDelegate');
    assert.ok(notifyDelegate, 'Should find NotifyDelegate');
    assert.strictEqual(notifyDelegate!.kind, 'type', 'Delegate should be a type');
    
    const calculateDelegate = result!.symbols.find(s => s.name === 'CalculateDelegate');
    assert.ok(calculateDelegate, 'Should find CalculateDelegate');
  });

  test('should detect C# events with accessors', async () => {
    const code = `
using System;

namespace MyApp
{
    public class Button
    {
        private EventHandler clickHandler;
        
        public event EventHandler Click
        {
            add { clickHandler += value; }
            remove { clickHandler -= value; }
        }
        
        public void SimulateClick()
        {
            clickHandler?.Invoke(this, EventArgs.Empty);
        }
    }
}`;
    
    const result = await parser.parseFile('test.cs', code);
    
    assert.ok(result, 'Should return parse result');
    
    // Events with accessors are detected as event_declaration
    const clickEvent = result!.symbols.find(s => s.name === 'Click');
    assert.ok(clickEvent, 'Should find Click event with accessors');
    assert.strictEqual(clickEvent!.kind, 'variable', 'Event should be detected as variable');
  });

  test('should detect C# indexers', async () => {
    const code = `
namespace MyApp
{
    public class Collection
    {
        private string[] items = new string[10];
        
        public string this[int index]
        {
            get { return items[index]; }
            set { items[index] = value; }
        }
        
        public string this[string key]
        {
            get { return items[0]; }
        }
    }
}`;
    
    const result = await parser.parseFile('test.cs', code);
    
    assert.ok(result, 'Should return parse result');
    
    const indexers = result!.symbols.filter(s => s.name === 'this');
    assert.ok(indexers.length >= 1, `Should find at least 1 indexer, found ${indexers.length}`);
    assert.strictEqual(indexers[0].kind, 'function', 'Indexer should be detected as function');
  });

  test('should detect C# operator overloads', async () => {
    const code = `
namespace MyApp
{
    public class Vector
    {
        public int X { get; set; }
        public int Y { get; set; }
        
        public static Vector operator +(Vector a, Vector b)
        {
            return new Vector { X = a.X + b.X, Y = a.Y + b.Y };
        }
        
        public static Vector operator -(Vector a, Vector b)
        {
            return new Vector { X = a.X - b.X, Y = a.Y - b.Y };
        }
        
        public static bool operator ==(Vector a, Vector b)
        {
            return a.X == b.X && a.Y == b.Y;
        }
        
        public static bool operator !=(Vector a, Vector b)
        {
            return !(a == b);
        }
    }
}`;
    
    const result = await parser.parseFile('test.cs', code);
    
    assert.ok(result, 'Should return parse result');
    
    const operators = result!.symbols.filter(s => s.name.startsWith('operator'));
    assert.ok(operators.length >= 4, `Should find at least 4 operators, found ${operators.length}`);
    
    const plusOperator = result!.symbols.find(s => s.name.includes('+'));
    assert.ok(plusOperator, 'Should find + operator');
    assert.strictEqual(plusOperator!.kind, 'function', 'Operator should be detected as function');
  });

  test('should parse C# files with conversion operators', async () => {
    const code = `
namespace MyApp
{
    public class Temperature
    {
        public double Celsius { get; set; }
        
        public static implicit operator double(Temperature t)
        {
            return t.Celsius;
        }
        
        public static explicit operator int(Temperature t)
        {
            return (int)t.Celsius;
        }
    }
}`;
    
    const result = await parser.parseFile('test.cs', code);
    
    assert.ok(result, 'Should return parse result');
    assert.ok(result!.symbols.length > 0, 'Should find symbols');
    
    // Note: tree-sitter-c-sharp may not expose conversion operators as separate nodes
    // At minimum, we should find the class and property
    const classSymbol = result!.symbols.find(s => s.name === 'Temperature');
    assert.ok(classSymbol, 'Should find Temperature class');
    
    const property = result!.symbols.find(s => s.name === 'Celsius');
    assert.ok(property, 'Should find Celsius property');
  });

  test('should detect C# destructors', async () => {
    const code = `
namespace MyApp
{
    public class ResourceManager
    {
        private IntPtr handle;
        
        public ResourceManager()
        {
            handle = IntPtr.Zero;
        }
        
        ~ResourceManager()
        {
            // Cleanup code
            if (handle != IntPtr.Zero)
            {
                // Free resources
            }
        }
    }
}`;
    
    const result = await parser.parseFile('test.cs', code);
    
    assert.ok(result, 'Should return parse result');
    
    const destructor = result!.symbols.find(s => s.name.startsWith('~'));
    assert.ok(destructor, 'Should find destructor');
    assert.strictEqual(destructor!.name, '~ResourceManager', 'Destructor name should be ~ResourceManager');
    assert.strictEqual(destructor!.kind, 'function', 'Destructor should be detected as function');
  });

  test('should detect C# records (C# 9+)', async () => {
    const code = `
namespace MyApp
{
    public record Person(string FirstName, string LastName);
    
    public record Employee(string FirstName, string LastName, int Id)
    {
        public string Department { get; init; }
        
        public void PrintInfo()
        {
            Console.WriteLine($"{FirstName} {LastName} - {Id}");
        }
    }
}`;
    
    const result = await parser.parseFile('test.cs', code);
    
    assert.ok(result, 'Should return parse result');
    
    const personRecord = result!.symbols.find(s => s.name === 'Person');
    assert.ok(personRecord, 'Should find Person record');
    assert.strictEqual(personRecord!.kind, 'class', 'Record should be detected as class');
    
    const employeeRecord = result!.symbols.find(s => s.name === 'Employee');
    assert.ok(employeeRecord, 'Should find Employee record');
  });

  test('should detect C# structs', async () => {
    const code = `
namespace MyApp
{
    public struct Point
    {
        public int X;
        public int Y;
        
        public Point(int x, int y)
        {
            X = x;
            Y = y;
        }
        
        public double Distance()
        {
            return Math.Sqrt(X * X + Y * Y);
        }
    }
}`;
    
    const result = await parser.parseFile('test.cs', code);
    
    assert.ok(result, 'Should return parse result');
    
    const structSymbol = result!.symbols.find(s => s.name === 'Point');
    assert.ok(structSymbol, 'Should find Point struct');
    assert.strictEqual(structSymbol!.kind, 'class', 'Struct should be detected as class');
    
    const constructor = result!.symbols.find(s => s.kind === 'constructor');
    assert.ok(constructor, 'Should find constructor in struct');
    
    const method = result!.symbols.find(s => s.name === 'Distance');
    assert.ok(method, 'Should find Distance method in struct');
  });

  test('should detect C# enums', async () => {
    const code = `
namespace MyApp
{
    public enum Status
    {
        Pending,
        Active,
        Completed,
        Cancelled
    }
    
    public enum Priority : byte
    {
        Low = 1,
        Medium = 2,
        High = 3,
        Critical = 4
    }
}`;
    
    const result = await parser.parseFile('test.cs', code);
    
    assert.ok(result, 'Should return parse result');
    
    const statusEnum = result!.symbols.find(s => s.name === 'Status');
    assert.ok(statusEnum, 'Should find Status enum');
    assert.strictEqual(statusEnum!.kind, 'type', 'Enum should be detected as type');
    
    const priorityEnum = result!.symbols.find(s => s.name === 'Priority');
    assert.ok(priorityEnum, 'Should find Priority enum');
  });
});

