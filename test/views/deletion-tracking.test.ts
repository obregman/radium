import * as assert from 'assert';
import { CodeParser } from '../../src/indexer/parser';

suite('Deletion Tracking Test Suite', () => {
  let parser: CodeParser;

  setup(() => {
    parser = new CodeParser();
  });

  suite('Code Deletion Within Files', () => {
    test('should detect deleted function in TypeScript', async () => {
      const originalCode = `
export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }

  subtract(a: number, b: number): number {
    return a - b;
  }

  multiply(a: number, b: number): number {
    return a * b;
  }
}`;

      const modifiedCode = `
export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }

  multiply(a: number, b: number): number {
    return a * b;
  }
}`;

      const originalResult = await parser.parseFile('calculator.ts', originalCode);
      const modifiedResult = await parser.parseFile('calculator.ts', modifiedCode);

      assert.ok(originalResult, 'Should parse original file');
      assert.ok(modifiedResult, 'Should parse modified file');

      // Get unique method names
      const originalMethodNames = new Set(
        originalResult!.symbols.filter(s => s.kind === 'function').map(s => s.name)
      );
      const modifiedMethodNames = new Set(
        modifiedResult!.symbols.filter(s => s.kind === 'function').map(s => s.name)
      );

      // Original should have add, subtract, multiply
      assert.ok(originalMethodNames.has('add'), 'Original should have add method');
      assert.ok(originalMethodNames.has('subtract'), 'Original should have subtract method');
      assert.ok(originalMethodNames.has('multiply'), 'Original should have multiply method');

      // Modified should have add, multiply but not subtract
      assert.ok(modifiedMethodNames.has('add'), 'Modified should have add method');
      assert.ok(modifiedMethodNames.has('multiply'), 'Modified should have multiply method');
      assert.ok(!modifiedMethodNames.has('subtract'), 'Modified should not have subtract method');
    });

    test('should detect deleted class in C#', async () => {
      const originalCode = `
namespace MyApp
{
    public class User
    {
        public string Name { get; set; }
    }

    public class Product
    {
        public int Id { get; set; }
    }

    public class Order
    {
        public int OrderId { get; set; }
    }
}`;

      const modifiedCode = `
namespace MyApp
{
    public class User
    {
        public string Name { get; set; }
    }

    public class Order
    {
        public int OrderId { get; set; }
    }
}`;

      const originalResult = await parser.parseFile('models.cs', originalCode);
      const modifiedResult = await parser.parseFile('models.cs', modifiedCode);

      assert.ok(originalResult, 'Should parse original file');
      assert.ok(modifiedResult, 'Should parse modified file');

      // Original should have 3 classes
      const originalClasses = originalResult!.symbols.filter(s => s.kind === 'class');
      assert.strictEqual(originalClasses.length, 3, 'Original should have 3 classes');

      // Modified should have 2 classes
      const modifiedClasses = modifiedResult!.symbols.filter(s => s.kind === 'class');
      assert.strictEqual(modifiedClasses.length, 2, 'Modified should have 2 classes');

      // Verify Product is missing
      const productInOriginal = originalClasses.find(c => c.name === 'Product');
      assert.ok(productInOriginal, 'Original should have Product class');

      const productInModified = modifiedClasses.find(c => c.name === 'Product');
      assert.strictEqual(productInModified, undefined, 'Modified should not have Product class');
    });

    test('should detect deleted struct in Go', async () => {
      const originalCode = `
package main

type Point struct {
    X int
    Y int
}

type Vector struct {
    X float64
    Y float64
}

type Color struct {
    R byte
    G byte
    B byte
}`;

      const modifiedCode = `
package main

type Point struct {
    X int
    Y int
}

type Color struct {
    R byte
    G byte
    B byte
}`;

      const originalResult = await parser.parseFile('types.go', originalCode);
      const modifiedResult = await parser.parseFile('types.go', modifiedCode);

      assert.ok(originalResult, 'Should parse original file');
      assert.ok(modifiedResult, 'Should parse modified file');

      // Original should have 3 structs
      const originalStructs = originalResult!.symbols.filter(s => s.kind === 'struct');
      assert.strictEqual(originalStructs.length, 3, 'Original should have 3 structs');

      // Modified should have 2 structs
      const modifiedStructs = modifiedResult!.symbols.filter(s => s.kind === 'struct');
      assert.strictEqual(modifiedStructs.length, 2, 'Modified should have 2 structs');

      // Verify Vector is missing
      const vectorInOriginal = originalStructs.find(s => s.name === 'Vector');
      assert.ok(vectorInOriginal, 'Original should have Vector struct');

      const vectorInModified = modifiedStructs.find(s => s.name === 'Vector');
      assert.strictEqual(vectorInModified, undefined, 'Modified should not have Vector struct');
    });

    test('should detect deleted interface in TypeScript', async () => {
      const originalCode = `
export interface User {
  id: string;
  name: string;
}

export interface Product {
  id: string;
  price: number;
}

export interface Order {
  id: string;
  userId: string;
}`;

      const modifiedCode = `
export interface User {
  id: string;
  name: string;
}

export interface Order {
  id: string;
  userId: string;
}`;

      const originalResult = await parser.parseFile('types.ts', originalCode);
      const modifiedResult = await parser.parseFile('types.ts', modifiedCode);

      assert.ok(originalResult, 'Should parse original file');
      assert.ok(modifiedResult, 'Should parse modified file');

      // Original should have 3 interfaces
      const originalInterfaces = originalResult!.symbols.filter(s => s.kind === 'interface');
      assert.strictEqual(originalInterfaces.length, 3, 'Original should have 3 interfaces');

      // Modified should have 2 interfaces
      const modifiedInterfaces = modifiedResult!.symbols.filter(s => s.kind === 'interface');
      assert.strictEqual(modifiedInterfaces.length, 2, 'Modified should have 2 interfaces');

      // Verify Product is missing
      const productInOriginal = originalInterfaces.find(i => i.name === 'Product');
      assert.ok(productInOriginal, 'Original should have Product interface');

      const productInModified = modifiedInterfaces.find(i => i.name === 'Product');
      assert.strictEqual(productInModified, undefined, 'Modified should not have Product interface');
    });

    test('should detect deleted method from class', async () => {
      const originalCode = `
export class UserService {
  async getUser(id: string): Promise<User> {
    return fetch(\`/api/users/\${id}\`);
  }

  async createUser(data: UserData): Promise<User> {
    return fetch('/api/users', { method: 'POST', body: JSON.stringify(data) });
  }

  async updateUser(id: string, data: UserData): Promise<User> {
    return fetch(\`/api/users/\${id}\`, { method: 'PUT', body: JSON.stringify(data) });
  }

  async deleteUser(id: string): Promise<void> {
    await fetch(\`/api/users/\${id}\`, { method: 'DELETE' });
  }
}`;

      const modifiedCode = `
export class UserService {
  async getUser(id: string): Promise<User> {
    return fetch(\`/api/users/\${id}\`);
  }

  async createUser(data: UserData): Promise<User> {
    return fetch('/api/users', { method: 'POST', body: JSON.stringify(data) });
  }

  async deleteUser(id: string): Promise<void> {
    await fetch(\`/api/users/\${id}\`, { method: 'DELETE' });
  }
}`;

      const originalResult = await parser.parseFile('user-service.ts', originalCode);
      const modifiedResult = await parser.parseFile('user-service.ts', modifiedCode);

      assert.ok(originalResult, 'Should parse original file');
      assert.ok(modifiedResult, 'Should parse modified file');

      // Get unique method names
      const originalMethodNames = new Set(
        originalResult!.symbols.filter(s => s.kind === 'function').map(s => s.name)
      );
      const modifiedMethodNames = new Set(
        modifiedResult!.symbols.filter(s => s.kind === 'function').map(s => s.name)
      );

      // Original should have all 4 methods
      assert.ok(originalMethodNames.has('getUser'), 'Original should have getUser method');
      assert.ok(originalMethodNames.has('createUser'), 'Original should have createUser method');
      assert.ok(originalMethodNames.has('updateUser'), 'Original should have updateUser method');
      assert.ok(originalMethodNames.has('deleteUser'), 'Original should have deleteUser method');

      // Modified should have 3 methods but not updateUser
      assert.ok(modifiedMethodNames.has('getUser'), 'Modified should have getUser method');
      assert.ok(modifiedMethodNames.has('createUser'), 'Modified should have createUser method');
      assert.ok(!modifiedMethodNames.has('updateUser'), 'Modified should not have updateUser method');
      assert.ok(modifiedMethodNames.has('deleteUser'), 'Modified should have deleteUser method');
    });

    test('should detect deleted constant in Go', async () => {
      const originalCode = `
package main

const (
    StatusOK = 200
    StatusCreated = 201
    StatusBadRequest = 400
    StatusNotFound = 404
    StatusError = 500
)`;

      const modifiedCode = `
package main

const (
    StatusOK = 200
    StatusBadRequest = 400
    StatusNotFound = 404
    StatusError = 500
)`;

      const originalResult = await parser.parseFile('constants.go', originalCode);
      const modifiedResult = await parser.parseFile('constants.go', modifiedCode);

      assert.ok(originalResult, 'Should parse original file');
      assert.ok(modifiedResult, 'Should parse modified file');

      // Original should have 5 constants
      const originalConstants = originalResult!.symbols.filter(s => s.kind === 'constant');
      assert.strictEqual(originalConstants.length, 5, 'Original should have 5 constants');

      // Modified should have 4 constants
      const modifiedConstants = modifiedResult!.symbols.filter(s => s.kind === 'constant');
      assert.strictEqual(modifiedConstants.length, 4, 'Modified should have 4 constants');

      // Verify StatusCreated is missing
      const statusCreatedInOriginal = originalConstants.find(c => c.name === 'StatusCreated');
      assert.ok(statusCreatedInOriginal, 'Original should have StatusCreated constant');

      const statusCreatedInModified = modifiedConstants.find(c => c.name === 'StatusCreated');
      assert.strictEqual(statusCreatedInModified, undefined, 'Modified should not have StatusCreated constant');
    });

    test('should detect multiple deletions in same file', async () => {
      const originalCode = `
export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

export function divide(a: number, b: number): number {
  return a / b;
}

export function modulo(a: number, b: number): number {
  return a % b;
}`;

      const modifiedCode = `
export function add(a: number, b: number): number {
  return a + b;
}

export function divide(a: number, b: number): number {
  return a / b;
}`;

      const originalResult = await parser.parseFile('math.ts', originalCode);
      const modifiedResult = await parser.parseFile('math.ts', modifiedCode);

      assert.ok(originalResult, 'Should parse original file');
      assert.ok(modifiedResult, 'Should parse modified file');

      // Original should have 5 functions
      const originalFunctions = originalResult!.symbols.filter(s => s.kind === 'function');
      assert.strictEqual(originalFunctions.length, 5, 'Original should have 5 functions');

      // Modified should have 2 functions
      const modifiedFunctions = modifiedResult!.symbols.filter(s => s.kind === 'function');
      assert.strictEqual(modifiedFunctions.length, 2, 'Modified should have 2 functions');

      // Verify 3 functions are missing
      const deletedFunctions = ['subtract', 'multiply', 'modulo'];
      for (const funcName of deletedFunctions) {
        const inOriginal = originalFunctions.find(f => f.name === funcName);
        assert.ok(inOriginal, `Original should have ${funcName} function`);

        const inModified = modifiedFunctions.find(f => f.name === funcName);
        assert.strictEqual(inModified, undefined, `Modified should not have ${funcName} function`);
      }
    });

    test('should detect deleted constructor in C#', async () => {
      const originalCode = `
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
        
        public string GetFullName()
        {
            return firstName + " " + lastName;
        }
    }
}`;

      const modifiedCode = `
namespace MyApp
{
    public class Person
    {
        private string firstName;
        private string lastName;
        
        public Person(string first, string last)
        {
            firstName = first;
            lastName = last;
        }
        
        public string GetFullName()
        {
            return firstName + " " + lastName;
        }
    }
}`;

      const originalResult = await parser.parseFile('person.cs', originalCode);
      const modifiedResult = await parser.parseFile('person.cs', modifiedCode);

      assert.ok(originalResult, 'Should parse original file');
      assert.ok(modifiedResult, 'Should parse modified file');

      // Original should have 2 constructors
      const originalConstructors = originalResult!.symbols.filter(s => s.kind === 'constructor');
      assert.strictEqual(originalConstructors.length, 2, 'Original should have 2 constructors');

      // Modified should have 1 constructor
      const modifiedConstructors = modifiedResult!.symbols.filter(s => s.kind === 'constructor');
      assert.strictEqual(modifiedConstructors.length, 1, 'Modified should have 1 constructor');
    });

    test('should handle complete file content deletion', async () => {
      const originalCode = `
export class DataService {
  async fetchData(): Promise<Data> {
    return fetch('/api/data');
  }
}

export class CacheService {
  get(key: string): any {
    return localStorage.getItem(key);
  }
}`;

      const modifiedCode = ``;

      const originalResult = await parser.parseFile('services.ts', originalCode);
      const modifiedResult = await parser.parseFile('services.ts', modifiedCode);

      assert.ok(originalResult, 'Should parse original file');
      assert.ok(modifiedResult, 'Should parse modified (empty) file');

      // Original should have symbols
      assert.ok(originalResult!.symbols.length > 0, 'Original should have symbols');

      // Modified should have no symbols
      assert.strictEqual(modifiedResult!.symbols.length, 0, 'Modified (empty) should have no symbols');
    });
  });

  suite('Symbol Range Tracking for Deletions', () => {
    test('should track line ranges for deleted functions', async () => {
      const originalCode = `
function first() {
  console.log('first');
}

function second() {
  console.log('second');
}

function third() {
  console.log('third');
}`;

      const originalResult = await parser.parseFile('functions.ts', originalCode);
      assert.ok(originalResult, 'Should parse original file');

      const functions = originalResult!.symbols.filter(s => s.kind === 'function');
      assert.strictEqual(functions.length, 3, 'Should have 3 functions');

      // Verify each function has a valid range
      for (const func of functions) {
        assert.ok(func.range, `Function ${func.name} should have a range`);
        assert.ok(func.range.start >= 0, `Function ${func.name} should have valid start`);
        assert.ok(func.range.end > func.range.start, `Function ${func.name} should have valid end`);
      }

      // Verify functions are in order
      const first = functions.find(f => f.name === 'first');
      const second = functions.find(f => f.name === 'second');
      const third = functions.find(f => f.name === 'third');

      assert.ok(first && second && third, 'Should find all three functions');
      assert.ok(first.range.end < second.range.start, 'first should come before second');
      assert.ok(second.range.end < third.range.start, 'second should come before third');
    });

    test('should track line ranges for deleted classes', async () => {
      const originalCode = `
export class Alpha {
  methodA() {}
}

export class Beta {
  methodB() {}
}

export class Gamma {
  methodC() {}
}`;

      const originalResult = await parser.parseFile('classes.ts', originalCode);
      assert.ok(originalResult, 'Should parse original file');

      const classes = originalResult!.symbols.filter(s => s.kind === 'class');
      assert.strictEqual(classes.length, 3, 'Should have 3 classes');

      // Verify each class has a valid range
      for (const cls of classes) {
        assert.ok(cls.range, `Class ${cls.name} should have a range`);
        assert.ok(cls.range.start >= 0, `Class ${cls.name} should have valid start`);
        assert.ok(cls.range.end > cls.range.start, `Class ${cls.name} should have valid end`);
      }
    });
  });

  suite('Edge Cases', () => {
    test('should handle deletion of only symbol in file', async () => {
      const originalCode = `
export function onlyFunction() {
  return 42;
}`;

      const modifiedCode = ``;

      const originalResult = await parser.parseFile('single.ts', originalCode);
      const modifiedResult = await parser.parseFile('single.ts', modifiedCode);

      assert.ok(originalResult, 'Should parse original file');
      assert.strictEqual(originalResult!.symbols.length, 1, 'Original should have 1 symbol');

      assert.ok(modifiedResult, 'Should parse modified file');
      assert.strictEqual(modifiedResult!.symbols.length, 0, 'Modified should have 0 symbols');
    });

    test('should handle deletion with comments remaining', async () => {
      const originalCode = `
// This is a comment
export function myFunction() {
  return true;
}
// Another comment`;

      const modifiedCode = `
// This is a comment
// Another comment`;

      const originalResult = await parser.parseFile('commented.ts', originalCode);
      const modifiedResult = await parser.parseFile('commented.ts', modifiedCode);

      assert.ok(originalResult, 'Should parse original file');
      assert.strictEqual(originalResult!.symbols.length, 1, 'Original should have 1 symbol');

      assert.ok(modifiedResult, 'Should parse modified file');
      assert.strictEqual(modifiedResult!.symbols.length, 0, 'Modified should have 0 symbols (comments ignored)');
    });

    test('should handle deletion of nested symbols', async () => {
      const originalCode = `
export class Outer {
  innerMethod1() {
    function nested1() {
      return 1;
    }
    return nested1();
  }

  innerMethod2() {
    function nested2() {
      return 2;
    }
    return nested2();
  }
}`;

      const modifiedCode = `
export class Outer {
  innerMethod1() {
    function nested1() {
      return 1;
    }
    return nested1();
  }
}`;

      const originalResult = await parser.parseFile('nested.ts', originalCode);
      const modifiedResult = await parser.parseFile('nested.ts', modifiedCode);

      assert.ok(originalResult, 'Should parse original file');
      assert.ok(modifiedResult, 'Should parse modified file');

      // Original should have more methods than modified
      const originalMethods = originalResult!.symbols.filter(s => s.kind === 'function');
      const modifiedMethods = modifiedResult!.symbols.filter(s => s.kind === 'function');

      assert.ok(originalMethods.length > modifiedMethods.length, 'Original should have more methods');

      // Verify innerMethod2 is missing
      const method2InOriginal = originalMethods.find(m => m.name === 'innerMethod2');
      assert.ok(method2InOriginal, 'Original should have innerMethod2');

      const method2InModified = modifiedMethods.find(m => m.name === 'innerMethod2');
      assert.strictEqual(method2InModified, undefined, 'Modified should not have innerMethod2');
    });
  });
});

