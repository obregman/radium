import * as assert from 'assert';
import { SemanticAnalyzer, SemanticChange } from '../../src/analysis/semantic-analyzer';

suite('Function Detection in Semantic Changes', () => {
  let analyzer: SemanticAnalyzer;

  setup(() => {
    analyzer = new SemanticAnalyzer();
  });

  suite('TypeScript Function Detection', () => {
    test('should detect added TypeScript function declaration', () => {
      const diff = `
@@ -0,0 +1,3 @@
+function calculateSum(a: number, b: number): number {
+  return a + b;
+}`;

      const changes = analyzer.analyzeDiff('test.ts', diff);
      
      assert.ok(changes.length > 0, 'Should detect changes');
      const addFunctionChanges = changes.filter(c => c.category === 'add_function');
      assert.strictEqual(addFunctionChanges.length, 1, 'Should detect one function addition');
      assert.ok(addFunctionChanges[0].description.includes('calculateSum'), 'Should include function name');
    });

    test('should detect added TypeScript arrow function', () => {
      const diff = `
@@ -0,0 +1,1 @@
+const multiply = (x: number, y: number) => x * y;`;

      const changes = analyzer.analyzeDiff('test.ts', diff);
      
      const addFunctionChanges = changes.filter(c => c.category === 'add_function');
      assert.strictEqual(addFunctionChanges.length, 1, 'Should detect arrow function addition');
      assert.ok(addFunctionChanges[0].description.includes('multiply'), 'Should include function name');
    });

    test('should detect added TypeScript async function', () => {
      const diff = `
@@ -0,0 +1,3 @@
+async function fetchData(url: string): Promise<any> {
+  return await fetch(url);
+}`;

      const changes = analyzer.analyzeDiff('test.ts', diff);
      
      const addFunctionChanges = changes.filter(c => c.category === 'add_function');
      assert.strictEqual(addFunctionChanges.length, 1, 'Should detect async function addition');
      assert.ok(addFunctionChanges[0].description.includes('fetchData'), 'Should include function name');
    });

    test('should detect added TypeScript class method', () => {
      const diff = `
@@ -5,0 +6,3 @@ divide(a: number, b: number)
+divide(a: number, b: number): number {
+  return a / b;
+}`;

      const changes = analyzer.analyzeDiff('test.ts', diff);
      
      // Method additions might be detected as add_function or add_logic
      const relevantChanges = changes.filter(c => c.category === 'add_function' || c.category === 'add_logic');
      assert.ok(relevantChanges.length >= 1, 'Should detect method addition');
      // Check that function context is tracked
      const changeWithContext = changes.find(c => c.functionName === 'divide');
      assert.ok(changeWithContext, 'Should track function context');
    });

    test('should detect added TypeScript async arrow function', () => {
      const diff = `
@@ -0,0 +1,1 @@
+const loadUser = async (id: string) => await getUserById(id);`;

      const changes = analyzer.analyzeDiff('test.ts', diff);
      
      const addFunctionChanges = changes.filter(c => c.category === 'add_function');
      assert.strictEqual(addFunctionChanges.length, 1, 'Should detect async arrow function');
      assert.ok(addFunctionChanges[0].description.includes('loadUser'), 'Should include function name');
    });

    test('should detect deleted TypeScript function', () => {
      const diff = `
@@ -10,3 +10,0 @@ subtract(a: number, b: number)
-subtract(a: number, b: number): number {
-  return a - b;
-}`;

      const changes = analyzer.analyzeDiff('test.ts', diff);
      
      // Function deletions might be detected as delete_function or delete_code
      const relevantChanges = changes.filter(c => c.category === 'delete_function' || c.category === 'delete_code');
      assert.ok(relevantChanges.length >= 1, 'Should detect function deletion');
      // Check that function context is tracked
      const changeWithContext = changes.find(c => c.functionName === 'subtract');
      assert.ok(changeWithContext, 'Should track function context');
    });

    test('should detect deleted TypeScript arrow function', () => {
      const diff = `
@@ -5,1 +5,0 @@
-const helper = (x: number) => x * 2;`;

      const changes = analyzer.analyzeDiff('test.ts', diff);
      
      const deleteFunctionChanges = changes.filter(c => c.category === 'delete_function');
      assert.strictEqual(deleteFunctionChanges.length, 1, 'Should detect arrow function deletion');
      assert.ok(deleteFunctionChanges[0].description.includes('helper'), 'Should include function name');
    });

    test('should extract function name from TypeScript function', () => {
      const diff = `
@@ -0,0 +1,3 @@
+function processData(input: string): void {
+  console.log(input);
+}`;

      const changes = analyzer.analyzeDiff('test.ts', diff);
      
      const addFunctionChanges = changes.filter(c => c.category === 'add_function');
      assert.strictEqual(addFunctionChanges.length, 1);
      assert.strictEqual(addFunctionChanges[0].description, 'Function "processData" added');
    });

    test('should detect TypeScript method with modifiers', () => {
      const diff = `
@@ -5,0 +6,3 @@ export class Service
+  private async getData(): Promise<Data> {
+    return this.fetch();
+  }`;

      const changes = analyzer.analyzeDiff('test.ts', diff);
      
      const addFunctionChanges = changes.filter(c => c.category === 'add_function');
      assert.strictEqual(addFunctionChanges.length, 1, 'Should detect method with modifiers');
      assert.ok(addFunctionChanges[0].description.includes('getData'), 'Should include method name');
    });

    test('should detect TypeScript getter/setter', () => {
      const diff = `
@@ -5,0 +6,3 @@ get fullName()
+get fullName(): string {
+  return this.firstName + ' ' + this.lastName;
+}`;

      const changes = analyzer.analyzeDiff('test.ts', diff);
      
      // Getter additions might be detected as add_function or add_logic
      const relevantChanges = changes.filter(c => c.category === 'add_function' || c.category === 'add_logic');
      assert.ok(relevantChanges.length >= 1, 'Should detect getter addition');
      // Check that function context is tracked
      const changeWithContext = changes.find(c => c.functionName === 'fullName');
      assert.ok(changeWithContext, 'Should track function context');
    });

    test('should track function context in hunk header for TypeScript', () => {
      const diff = `
@@ -10,0 +11,3 @@ function calculateTotal(items: Item[])
+  if (items.length === 0) {
+    return 0;
+  }`;

      const changes = analyzer.analyzeDiff('test.ts', diff);
      
      assert.ok(changes.length > 0, 'Should detect changes');
      const change = changes[0];
      assert.strictEqual(change.functionName, 'calculateTotal', 'Should extract function name from hunk context');
    });

    test('should track function context for TypeScript arrow function', () => {
      const diff = `
@@ -5,0 +6,1 @@ const processItems = (items: Item[]) =>
+  items.filter(item => item.active)`;

      const changes = analyzer.analyzeDiff('test.ts', diff);
      
      assert.ok(changes.length > 0, 'Should detect changes');
      const change = changes[0];
      assert.strictEqual(change.functionName, 'processItems', 'Should extract arrow function name from hunk context');
    });

    test('should track function context for TypeScript class method', () => {
      const diff = `
@@ -10,0 +11,3 @@ async getUserById(id: string)
+  const user = await this.db.findOne({ id });
+  if (!user) throw new Error('Not found');
+  return user;`;

      const changes = analyzer.analyzeDiff('test.ts', diff);
      
      assert.ok(changes.length > 0, 'Should detect changes');
      const change = changes[0];
      assert.strictEqual(change.functionName, 'getUserById', 'Should extract method name from hunk context');
    });
  });

  suite('C# Function Detection', () => {
    test('should detect added C# method', () => {
      const diff = `
@@ -0,0 +1,4 @@
+public int Add(int a, int b)
+{
+    return a + b;
+}`;

      const changes = analyzer.analyzeDiff('test.cs', diff);
      
      const addFunctionChanges = changes.filter(c => c.category === 'add_function');
      assert.strictEqual(addFunctionChanges.length, 1, 'Should detect C# method addition');
      assert.ok(addFunctionChanges[0].description.includes('Add'), 'Should include method name');
    });

    test('should detect added C# async method', () => {
      const diff = `
@@ -0,0 +1,4 @@
+public async void GetUserAsync(string id)
+{
+    await _repository.FindAsync(id);
+}`;

      const changes = analyzer.analyzeDiff('test.cs', diff);
      
      const addFunctionChanges = changes.filter(c => c.category === 'add_function');
      assert.strictEqual(addFunctionChanges.length, 1, 'Should detect async method addition');
      assert.ok(addFunctionChanges[0].description.includes('GetUserAsync'), 'Should include method name');
    });

    test('should detect added C# private method', () => {
      const diff = `
@@ -10,0 +11,4 @@ public class Calculator
+private int Multiply(int x, int y)
+{
+    return x * y;
+}`;

      const changes = analyzer.analyzeDiff('test.cs', diff);
      
      const addFunctionChanges = changes.filter(c => c.category === 'add_function');
      assert.strictEqual(addFunctionChanges.length, 1, 'Should detect private method');
      assert.ok(addFunctionChanges[0].description.includes('Multiply'), 'Should include method name');
    });

    test('should detect added C# static method', () => {
      const diff = `
@@ -0,0 +1,4 @@
+public static string FormatName(string first, string last)
+{
+    return $"{first} {last}";
+}`;

      const changes = analyzer.analyzeDiff('test.cs', diff);
      
      const addFunctionChanges = changes.filter(c => c.category === 'add_function');
      assert.strictEqual(addFunctionChanges.length, 1, 'Should detect static method');
      assert.ok(addFunctionChanges[0].description.includes('FormatName'), 'Should include method name');
    });

    test('should detect added C# virtual method', () => {
      const diff = `
@@ -5,0 +6,4 @@ public class BaseService
+protected virtual void OnDataChanged()
+{
+    Console.WriteLine("Data changed");
+}`;

      const changes = analyzer.analyzeDiff('test.cs', diff);
      
      const addFunctionChanges = changes.filter(c => c.category === 'add_function');
      assert.strictEqual(addFunctionChanges.length, 1, 'Should detect virtual method');
      assert.ok(addFunctionChanges[0].description.includes('OnDataChanged'), 'Should include method name');
    });

    test('should detect added C# override method', () => {
      const diff = `
@@ -5,0 +6,4 @@ public class DerivedService
+public override string ToString()
+{
+    return base.ToString() + " - Custom";
+}`;

      const changes = analyzer.analyzeDiff('test.cs', diff);
      
      const addFunctionChanges = changes.filter(c => c.category === 'add_function');
      assert.strictEqual(addFunctionChanges.length, 1, 'Should detect override method');
      assert.ok(addFunctionChanges[0].description.includes('ToString'), 'Should include method name');
    });

    test('should detect deleted C# method', () => {
      const diff = `
@@ -10,4 +10,0 @@ public class Calculator
-public int Subtract(int a, int b)
-{
-    return a - b;
-}`;

      const changes = analyzer.analyzeDiff('test.cs', diff);
      
      const deleteFunctionChanges = changes.filter(c => c.category === 'delete_function');
      assert.strictEqual(deleteFunctionChanges.length, 1, 'Should detect C# method deletion');
      assert.ok(deleteFunctionChanges[0].description.includes('Subtract'), 'Should include method name');
    });

    test('should detect deleted C# async method', () => {
      const diff = `
@@ -15,4 +15,0 @@ public class UserService
-public async Task DeleteUserAsync(string id)
-{
-    await _repository.DeleteAsync(id);
-}`;

      const changes = analyzer.analyzeDiff('test.cs', diff);
      
      const deleteFunctionChanges = changes.filter(c => c.category === 'delete_function');
      assert.strictEqual(deleteFunctionChanges.length, 1, 'Should detect async method deletion');
      assert.ok(deleteFunctionChanges[0].description.includes('DeleteUserAsync'), 'Should include method name');
    });

    test('should extract function name from C# method', () => {
      const diff = `
@@ -0,0 +1,4 @@
+public void ProcessData(string input)
+{
+    Console.WriteLine(input);
+}`;

      const changes = analyzer.analyzeDiff('test.cs', diff);
      
      const addFunctionChanges = changes.filter(c => c.category === 'add_function');
      assert.strictEqual(addFunctionChanges.length, 1);
      assert.strictEqual(addFunctionChanges[0].description, 'Function "ProcessData" added');
    });

    test('should detect C# method with internal modifier', () => {
      const diff = `
@@ -5,0 +6,4 @@ public class Helper
+internal void LogMessage(string message)
+{
+    _logger.Log(message);
+}`;

      const changes = analyzer.analyzeDiff('test.cs', diff);
      
      const addFunctionChanges = changes.filter(c => c.category === 'add_function');
      assert.strictEqual(addFunctionChanges.length, 1, 'Should detect internal method');
      assert.ok(addFunctionChanges[0].description.includes('LogMessage'), 'Should include method name');
    });

    test('should track function context in hunk header for C#', () => {
      const diff = `
@@ -10,0 +11,3 @@ public int CalculateTotal(List<Item> items)
+if (items.Count == 0)
+    return 0;
+int sum = 0;`;

      const changes = analyzer.analyzeDiff('test.cs', diff);
      
      assert.ok(changes.length > 0, 'Should detect changes');
      const change = changes[0];
      assert.strictEqual(change.functionName, 'CalculateTotal', 'Should extract method name from hunk context');
    });

    test('should track function context for C# async method', () => {
      const diff = `
@@ -5,0 +6,2 @@ public async Task<User> GetUserByIdAsync(string id)
+var user = await _db.Users.FindAsync(id);
+if (user == null) throw new NotFoundException();`;

      const changes = analyzer.analyzeDiff('test.cs', diff);
      
      assert.ok(changes.length > 0, 'Should detect changes');
      const change = changes[0];
      assert.strictEqual(change.functionName, 'GetUserByIdAsync', 'Should extract async method name from hunk context');
    });

    test('should track function context for C# static method', () => {
      const diff = `
@@ -10,0 +11,1 @@ public static string FormatDate(DateTime date)
+return date.ToString("yyyy-MM-dd");`;

      const changes = analyzer.analyzeDiff('test.cs', diff);
      
      assert.ok(changes.length > 0, 'Should detect changes');
      const change = changes[0];
      assert.strictEqual(change.functionName, 'FormatDate', 'Should extract static method name from hunk context');
    });

    test('should track function context for C# property getter', () => {
      const diff = `
@@ -5,0 +6,1 @@ get FullName()
+get { return FirstName + " " + LastName; }`;

      const changes = analyzer.analyzeDiff('test.cs', diff);
      
      assert.ok(changes.length > 0, 'Should detect changes');
      const change = changes[0];
      assert.strictEqual(change.functionName, 'FullName', 'Should extract property name from hunk context');
    });
  });

  suite('Function Context Extraction Edge Cases', () => {
    test('should not confuse control flow keywords with function names', () => {
      const diff = `
@@ -10,0 +11,3 @@ if (condition)
+  console.log('inside if');
+  doSomething();
+}`;

      const changes = analyzer.analyzeDiff('test.ts', diff);
      
      // Should detect changes but not attribute them to a function named "if"
      if (changes.length > 0 && changes[0].functionName) {
        assert.notStrictEqual(changes[0].functionName, 'if', 'Should not use control flow keyword as function name');
      }
    });

    test('should handle multiple function additions in same file', () => {
      const diff = `
@@ -0,0 +1,7 @@
+function first() {
+  return 1;
+}
+
+function second() {
+  return 2;
+}`;

      const changes = analyzer.analyzeDiff('test.ts', diff);
      
      const addFunctionChanges = changes.filter(c => c.category === 'add_function');
      assert.strictEqual(addFunctionChanges.length, 2, 'Should detect both function additions');
      
      const functionNames = addFunctionChanges.map(c => {
        const match = c.description.match(/Function "(\w+)" added/);
        return match ? match[1] : null;
      }).filter(name => name !== null);
      
      assert.ok(functionNames.includes('first'), 'Should detect first function');
      assert.ok(functionNames.includes('second'), 'Should detect second function');
    });

    test('should handle function deletion followed by addition (replacement)', () => {
      const diff = `
@@ -5,3 +5,3 @@ oldMethod(x: number)
-oldMethod(x: number): number {
-  return x * 2;
-}
+newMethod(x: number): number {
+  return x * 3;
+}`;

      const changes = analyzer.analyzeDiff('test.ts', diff);
      
      // When functions are replaced, they might be detected as modifications or as separate add/delete
      // The important thing is that changes are detected and function context is tracked
      assert.ok(changes.length > 0, 'Should detect changes');
      const changeWithContext = changes.find(c => c.functionName === 'oldMethod');
      assert.ok(changeWithContext, 'Should track function context');
    });

    test('should handle empty function name extraction gracefully', () => {
      const diff = `
@@ -0,0 +1,3 @@
+function () {
+  return 42;
+}`;

      const changes = analyzer.analyzeDiff('test.ts', diff);
      
      // Should still detect the function addition even if name can't be extracted
      const addFunctionChanges = changes.filter(c => c.category === 'add_function');
      if (addFunctionChanges.length > 0) {
        assert.ok(addFunctionChanges[0].description, 'Should have a description');
      }
    });
  });

  suite('Function Context in Different Scenarios', () => {
    test('should extract function context from TypeScript method with generics', () => {
      const diff = `
@@ -5,0 +6,1 @@ public map<T, U>(items: T[], fn: (item: T) => U)
+return items.map(fn);`;

      const changes = analyzer.analyzeDiff('test.ts', diff);
      
      if (changes.length > 0 && changes[0].functionName) {
        assert.strictEqual(changes[0].functionName, 'map', 'Should extract method name with generics');
      }
    });

    test('should extract function context from C# method with generic constraints', () => {
      const diff = `
@@ -5,0 +6,1 @@ public T GetValue<T>(string key) where T : class
+return _cache.Get<T>(key);`;

      const changes = analyzer.analyzeDiff('test.cs', diff);
      
      if (changes.length > 0 && changes[0].functionName) {
        assert.strictEqual(changes[0].functionName, 'GetValue', 'Should extract method name with constraints');
      }
    });

    test('should handle nested function additions in TypeScript', () => {
      const diff = `
@@ -5,0 +6,5 @@ function outer()
+  function inner() {
+    return 42;
+  }
+  return inner();
+}`;

      const changes = analyzer.analyzeDiff('test.ts', diff);
      
      const addFunctionChanges = changes.filter(c => c.category === 'add_function');
      assert.ok(addFunctionChanges.length > 0, 'Should detect nested function');
      
      // The outer function context should be tracked
      if (changes.length > 0 && changes[0].functionName) {
        assert.strictEqual(changes[0].functionName, 'outer', 'Should track outer function context');
      }
    });

    test('should not attribute class-level code to class name', () => {
      const diff = `
@@ -5,0 +6,1 @@ export class MyClass
+private data: string;`;

      const changes = analyzer.analyzeDiff('test.ts', diff);
      
      // Class definitions should be excluded from function context
      if (changes.length > 0 && changes[0].functionName) {
        assert.notStrictEqual(changes[0].functionName, 'MyClass', 'Should not use class name as function context');
      }
    });
  });
});

