import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { CodeParser } from '../../src/indexer/parser';

suite('Symbol Deletion Detection Test Suite', () => {
  let parser: CodeParser;
  let tempDir: string;

  setup(() => {
    parser = new CodeParser();
    // Create a temporary directory for test files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radium-test-'));
  });

  teardown(() => {
    // Clean up temporary directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('should detect function deletion in JavaScript file', async () => {
    const testFile = path.join(tempDir, 'test.js');
    
    // Write initial file with 3 functions
    const initialCode = `
function add(a, b) {
  return a + b;
}

function subtract(a, b) {
  return a - b;
}

function multiply(a, b) {
  return a * b;
}`;
    
    fs.writeFileSync(testFile, initialCode);
    
    // Parse initial state
    const initialResult = await parser.parseFile(testFile, initialCode);
    assert.ok(initialResult, 'Should parse initial file');
    
    const initialFunctions = initialResult!.symbols.filter(s => s.kind === 'function');
    assert.strictEqual(initialFunctions.length, 3, 'Should have 3 functions initially');
    
    // Now delete the subtract function
    const modifiedCode = `
function add(a, b) {
  return a + b;
}

function multiply(a, b) {
  return a * b;
}`;
    
    fs.writeFileSync(testFile, modifiedCode);
    
    // Parse modified state
    const modifiedResult = await parser.parseFile(testFile, modifiedCode);
    assert.ok(modifiedResult, 'Should parse modified file');
    
    const modifiedFunctions = modifiedResult!.symbols.filter(s => s.kind === 'function');
    assert.strictEqual(modifiedFunctions.length, 2, 'Should have 2 functions after deletion');
    
    // Verify subtract function is gone
    const subtractExists = modifiedFunctions.some(f => f.name === 'subtract');
    assert.strictEqual(subtractExists, false, 'subtract function should be deleted');
    
    // Verify other functions still exist
    const addExists = modifiedFunctions.some(f => f.name === 'add');
    const multiplyExists = modifiedFunctions.some(f => f.name === 'multiply');
    assert.ok(addExists, 'add function should still exist');
    assert.ok(multiplyExists, 'multiply function should still exist');
  });

  test('should detect class deletion in TypeScript file', async () => {
    const testFile = path.join(tempDir, 'test.ts');
    
    // Write initial file with 3 classes
    const initialCode = `
export class User {
  name: string;
}

export class Product {
  id: number;
}

export class Order {
  orderId: string;
}`;
    
    fs.writeFileSync(testFile, initialCode);
    
    // Parse initial state
    const initialResult = await parser.parseFile(testFile, initialCode);
    assert.ok(initialResult, 'Should parse initial file');
    
    const initialClasses = initialResult!.symbols.filter(s => s.kind === 'class');
    assert.strictEqual(initialClasses.length, 3, 'Should have 3 classes initially');
    
    // Now delete the Product class
    const modifiedCode = `
export class User {
  name: string;
}

export class Order {
  orderId: string;
}`;
    
    fs.writeFileSync(testFile, modifiedCode);
    
    // Parse modified state
    const modifiedResult = await parser.parseFile(testFile, modifiedCode);
    assert.ok(modifiedResult, 'Should parse modified file');
    
    const modifiedClasses = modifiedResult!.symbols.filter(s => s.kind === 'class');
    assert.strictEqual(modifiedClasses.length, 2, 'Should have 2 classes after deletion');
    
    // Verify Product class is gone
    const productExists = modifiedClasses.some(c => c.name === 'Product');
    assert.strictEqual(productExists, false, 'Product class should be deleted');
  });

  test('should detect multiple function deletions in same file', async () => {
    const testFile = path.join(tempDir, 'math.js');
    
    // Write initial file with 5 functions
    const initialCode = `
function add(a, b) { return a + b; }
function subtract(a, b) { return a - b; }
function multiply(a, b) { return a * b; }
function divide(a, b) { return a / b; }
function modulo(a, b) { return a % b; }`;
    
    fs.writeFileSync(testFile, initialCode);
    
    // Parse initial state
    const initialResult = await parser.parseFile(testFile, initialCode);
    assert.ok(initialResult, 'Should parse initial file');
    
    const initialFunctions = initialResult!.symbols.filter(s => s.kind === 'function');
    assert.strictEqual(initialFunctions.length, 5, 'Should have 5 functions initially');
    
    // Delete 3 functions, keep only add and divide
    const modifiedCode = `
function add(a, b) { return a + b; }
function divide(a, b) { return a / b; }`;
    
    fs.writeFileSync(testFile, modifiedCode);
    
    // Parse modified state
    const modifiedResult = await parser.parseFile(testFile, modifiedCode);
    assert.ok(modifiedResult, 'Should parse modified file');
    
    const modifiedFunctions = modifiedResult!.symbols.filter(s => s.kind === 'function');
    assert.strictEqual(modifiedFunctions.length, 2, 'Should have 2 functions after deletion');
    
    // Verify deleted functions are gone
    const deletedFunctions = ['subtract', 'multiply', 'modulo'];
    for (const funcName of deletedFunctions) {
      const exists = modifiedFunctions.some(f => f.name === funcName);
      assert.strictEqual(exists, false, `${funcName} function should be deleted`);
    }
    
    // Verify remaining functions exist
    assert.ok(modifiedFunctions.some(f => f.name === 'add'), 'add should still exist');
    assert.ok(modifiedFunctions.some(f => f.name === 'divide'), 'divide should still exist');
  });

  test('should detect method deletion from class', async () => {
    const testFile = path.join(tempDir, 'service.ts');
    
    // Write initial file with class and 4 methods
    const initialCode = `
export class UserService {
  getUser(id: string) { return null; }
  createUser(data: any) { return null; }
  updateUser(id: string, data: any) { return null; }
  deleteUser(id: string) { return null; }
}`;
    
    fs.writeFileSync(testFile, initialCode);
    
    // Parse initial state
    const initialResult = await parser.parseFile(testFile, initialCode);
    assert.ok(initialResult, 'Should parse initial file');
    
    const initialMethods = initialResult!.symbols.filter(s => s.kind === 'function');
    assert.ok(initialMethods.length >= 4, 'Should have at least 4 methods initially');
    
    // Delete updateUser method
    const modifiedCode = `
export class UserService {
  getUser(id: string) { return null; }
  createUser(data: any) { return null; }
  deleteUser(id: string) { return null; }
}`;
    
    fs.writeFileSync(testFile, modifiedCode);
    
    // Parse modified state
    const modifiedResult = await parser.parseFile(testFile, modifiedCode);
    assert.ok(modifiedResult, 'Should parse modified file');
    
    const modifiedMethods = modifiedResult!.symbols.filter(s => s.kind === 'function');
    
    // Verify updateUser is gone
    const updateUserExists = modifiedMethods.some(m => m.name === 'updateUser');
    assert.strictEqual(updateUserExists, false, 'updateUser method should be deleted');
    
    // Verify other methods still exist
    assert.ok(modifiedMethods.some(m => m.name === 'getUser'), 'getUser should still exist');
    assert.ok(modifiedMethods.some(m => m.name === 'createUser'), 'createUser should still exist');
    assert.ok(modifiedMethods.some(m => m.name === 'deleteUser'), 'deleteUser should still exist');
  });

  test('should handle deletion of all symbols in file', async () => {
    const testFile = path.join(tempDir, 'empty.js');
    
    // Write initial file with functions
    const initialCode = `
function foo() { return 1; }
function bar() { return 2; }`;
    
    fs.writeFileSync(testFile, initialCode);
    
    // Parse initial state
    const initialResult = await parser.parseFile(testFile, initialCode);
    assert.ok(initialResult, 'Should parse initial file');
    assert.ok(initialResult!.symbols.length > 0, 'Should have symbols initially');
    
    // Delete all content
    const modifiedCode = ``;
    
    fs.writeFileSync(testFile, modifiedCode);
    
    // Parse modified state
    const modifiedResult = await parser.parseFile(testFile, modifiedCode);
    assert.ok(modifiedResult, 'Should parse modified (empty) file');
    assert.strictEqual(modifiedResult!.symbols.length, 0, 'Should have no symbols after deletion');
  });

  test('should track symbol ranges for deleted symbols', async () => {
    const testFile = path.join(tempDir, 'ranges.js');
    
    // Write file with functions at different positions
    const initialCode = `
function first() {
  console.log('first');
}

function second() {
  console.log('second');
}

function third() {
  console.log('third');
}`;
    
    fs.writeFileSync(testFile, initialCode);
    
    // Parse initial state
    const initialResult = await parser.parseFile(testFile, initialCode);
    assert.ok(initialResult, 'Should parse initial file');
    
    const functions = initialResult!.symbols.filter(s => s.kind === 'function');
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
});

