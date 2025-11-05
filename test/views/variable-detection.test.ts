import * as assert from 'assert';

/**
 * Tests for variable detection logic
 * Verifies that only file-level and class-level variables are detected,
 * not variables inside functions
 */

// Mock the detectVariableContext function for testing
function detectVariableContext(content: string, lineNumber: number): { type: string; name: string } | null | 'file-level' {
  const lines = content.split('\n');
  
  // Look backwards from the line to find containing structure
  let braceDepth = 0;
  let foundFunction = false;
  let foundClass = false;
  let classInfo: { type: string; name: string } | null = null;
  
  for (let i = lineNumber - 1; i >= 0; i--) {
    const line = lines[i];
    
    // Check for patterns BEFORE counting braces
    if (braceDepth === 0) {
      // Check for function first (more specific) - if found, variable is in function
      const functionMatch = line.match(/\b(function|async\s+function)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
      if (functionMatch) {
        foundFunction = true;
        break; // Variable is inside a function
      }
      
      // Arrow functions (e.g., const fn = () => { or const fn = (x) => {)
      const arrowMatch = line.match(/=\s*\([^)]*\)\s*=>/);
      if (arrowMatch) {
        foundFunction = true;
        break; // Variable is inside an arrow function
      }
      
      // Method definitions (e.g., methodName() { or methodName(params) {)
      const methodMatch = line.match(/\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\([^)]*\)\s*[:{]/);
      if (methodMatch) {
        foundFunction = true;
        break; // Variable is inside a method/function
      }
      
      // Check for class/interface
      const classMatch = line.match(/\b(class|interface)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
      if (classMatch) {
        foundClass = true;
        classInfo = { type: classMatch[1], name: classMatch[2] };
        // Don't break - keep looking for functions inside the class
      }
    }
    
    // Count braces to track nesting (going backward, so we reverse the logic)
    // When going backwards: '}' increases depth (we're entering a scope), '{' decreases it (we're exiting)
    for (const char of line) {
      if (char === '}') braceDepth++;
      if (char === '{') braceDepth--;
    }
    
    // Stop if we've exited the containing scope (braceDepth < 0 means we've gone too far out)
    if (braceDepth < 0) break;
  }
  
  // If inside a function, return null (skip this variable)
  if (foundFunction) {
    return null;
  }
  
  // If inside a class but not inside a function, return class info
  if (foundClass && classInfo) {
    return classInfo;
  }
  
  // File-level variable (not inside any function or class)
  return 'file-level';
}

suite('Variable Detection Tests', () => {
  test('File-level variable should be detected', () => {
    const content = `const API_URL = "https://api.example.com";
const MAX_RETRIES = 3;

function doSomething() {
  console.log('test');
}`;

    const context1 = detectVariableContext(content, 1);
    assert.strictEqual(context1, 'file-level', 'First line variable should be file-level');

    const context2 = detectVariableContext(content, 2);
    assert.strictEqual(context2, 'file-level', 'Second line variable should be file-level');
  });

  test('Variable inside function should return null', () => {
    const content = `function doSomething() {
  const result = 42;
  const name = "test";
  return result;
}`;

    const context = detectVariableContext(content, 2);
    assert.strictEqual(context, null, 'Variable inside function should return null');

    const context2 = detectVariableContext(content, 3);
    assert.strictEqual(context2, null, 'Second variable inside function should return null');
  });

  test('Variable inside arrow function should return null', () => {
    const content = `const doSomething = () => {
  const result = 42;
  return result;
};`;

    const context = detectVariableContext(content, 2);
    assert.strictEqual(context, null, 'Variable inside arrow function should return null');
  });

  test('Class property should be detected', () => {
    const content = `class MyClass {
  private count = 0;
  public name = "test";

  constructor() {
    this.count = 1;
  }
}`;

    const context1 = detectVariableContext(content, 2);
    assert.deepStrictEqual(context1, { type: 'class', name: 'MyClass' }, 
      'Class property should return class context');

    const context2 = detectVariableContext(content, 3);
    assert.deepStrictEqual(context2, { type: 'class', name: 'MyClass' },
      'Second class property should return class context');
  });

  test('Variable inside class method should return null', () => {
    const content = `class MyClass {
  private count = 0;

  doSomething() {
    const temp = 42;
    return temp;
  }
}`;

    const context = detectVariableContext(content, 5);
    assert.strictEqual(context, null, 'Variable inside class method should return null');
  });

  test('Variable inside nested function should return null', () => {
    const content = `function outer() {
  const outerVar = 1;
  
  function inner() {
    const innerVar = 2;
    return innerVar;
  }
  
  return outerVar;
}`;

    const context1 = detectVariableContext(content, 2);
    assert.strictEqual(context1, null, 'Variable in outer function should return null');

    const context2 = detectVariableContext(content, 5);
    assert.strictEqual(context2, null, 'Variable in inner function should return null');
  });

  test('File-level variable after function should be detected', () => {
    const content = `function doSomething() {
  const temp = 42;
}

const API_KEY = "secret";`;

    const context = detectVariableContext(content, 5);
    assert.strictEqual(context, 'file-level', 'Variable after function should be file-level');
  });

  test('Variable in async function should return null', () => {
    const content = `async function fetchData() {
  const response = await fetch(url);
  const data = await response.json();
  return data;
}`;

    const context1 = detectVariableContext(content, 2);
    assert.strictEqual(context1, null, 'Variable in async function should return null');

    const context2 = detectVariableContext(content, 3);
    assert.strictEqual(context2, null, 'Second variable in async function should return null');
  });

  test('Interface property should be detected', () => {
    const content = `interface MyInterface {
  count: number;
  name: string;
}`;

    const context1 = detectVariableContext(content, 2);
    assert.deepStrictEqual(context1, { type: 'interface', name: 'MyInterface' },
      'Interface property should return interface context');

    const context2 = detectVariableContext(content, 3);
    assert.deepStrictEqual(context2, { type: 'interface', name: 'MyInterface' },
      'Second interface property should return interface context');
  });

  test('Variable in for loop should return null', () => {
    const content = `function process() {
  for (let i = 0; i < 10; i++) {
    const item = items[i];
    console.log(item);
  }
}`;

    const context = detectVariableContext(content, 3);
    assert.strictEqual(context, null, 'Variable in for loop should return null');
  });

  test('Variable in if block inside function should return null', () => {
    const content = `function check() {
  if (condition) {
    const result = true;
    return result;
  }
}`;

    const context = detectVariableContext(content, 3);
    assert.strictEqual(context, null, 'Variable in if block inside function should return null');
  });

  test('Multiple file-level variables', () => {
    const content = `const API_URL = "https://api.example.com";
const API_KEY = "secret";
const MAX_RETRIES = 3;
const TIMEOUT = 5000;`;

    for (let line = 1; line <= 4; line++) {
      const context = detectVariableContext(content, line);
      assert.strictEqual(context, 'file-level', 
        `Line ${line} variable should be file-level`);
    }
  });

  test('Class with multiple properties and methods', () => {
    const content = `class Counter {
  private count = 0;
  private name = "counter";

  increment() {
    const step = 1;
    this.count += step;
  }

  decrement() {
    const step = 1;
    this.count -= step;
  }
}`;

    // Class properties should be detected
    const prop1 = detectVariableContext(content, 2);
    assert.deepStrictEqual(prop1, { type: 'class', name: 'Counter' },
      'First class property should be detected');

    const prop2 = detectVariableContext(content, 3);
    assert.deepStrictEqual(prop2, { type: 'class', name: 'Counter' },
      'Second class property should be detected');

    // Variables inside methods should return null
    const methodVar1 = detectVariableContext(content, 6);
    assert.strictEqual(methodVar1, null, 
      'Variable inside first method should return null');

    const methodVar2 = detectVariableContext(content, 11);
    assert.strictEqual(methodVar2, null,
      'Variable inside second method should return null');
  });

  test('Python file-level variable', () => {
    const content = `API_URL = "https://api.example.com"
MAX_RETRIES = 3

def do_something():
    result = 42
    return result`;

    const context1 = detectVariableContext(content, 1);
    assert.strictEqual(context1, 'file-level', 'Python file-level variable should be detected');

    const context2 = detectVariableContext(content, 2);
    assert.strictEqual(context2, 'file-level', 'Second Python file-level variable should be detected');
  });

  test('Python variable inside function should return null', () => {
    const content = `def do_something():
    result = 42
    name = "test"
    return result`;

    const context1 = detectVariableContext(content, 2);
    assert.strictEqual(context1, null, 'Python variable inside function should return null');

    const context2 = detectVariableContext(content, 3);
    assert.strictEqual(context2, null, 'Second Python variable inside function should return null');
  });

  test('Python class variable', () => {
    const content = `class MyClass:
    count = 0
    name = "test"

    def do_something(self):
        temp = 42
        return temp`;

    const context1 = detectVariableContext(content, 2);
    assert.deepStrictEqual(context1, { type: 'class', name: 'MyClass' },
      'Python class variable should return class context');

    const context2 = detectVariableContext(content, 3);
    assert.deepStrictEqual(context2, { type: 'class', name: 'MyClass' },
      'Second Python class variable should return class context');

    const methodVar = detectVariableContext(content, 6);
    assert.strictEqual(methodVar, null,
      'Python variable inside method should return null');
  });

  test('Complex nested structure', () => {
    const content = `const FILE_LEVEL = "file";

class Outer {
  classVar = "class";

  method1() {
    const methodVar = "method";
    
    if (true) {
      const ifVar = "if";
    }
  }
}

function standalone() {
  const funcVar = "func";
}

const ANOTHER_FILE_LEVEL = "file2";`;

    const fileLevelContext1 = detectVariableContext(content, 1);
    assert.strictEqual(fileLevelContext1, 'file-level', 'First file-level var');

    const classVarContext = detectVariableContext(content, 4);
    assert.deepStrictEqual(classVarContext, { type: 'class', name: 'Outer' }, 'Class var');

    const methodVarContext = detectVariableContext(content, 7);
    assert.strictEqual(methodVarContext, null, 'Method var should be null');

    const ifVarContext = detectVariableContext(content, 10);
    assert.strictEqual(ifVarContext, null, 'If block var should be null');

    const funcVarContext = detectVariableContext(content, 16);
    assert.strictEqual(funcVarContext, null, 'Function var should be null');

    const fileLevelContext2 = detectVariableContext(content, 19);
    assert.strictEqual(fileLevelContext2, 'file-level', 'Second file-level var');
  });

  test('Arrow function assigned to const', () => {
    const content = `const myFunction = () => {
  const result = 42;
  return result;
};

const CONSTANT = "value";`;

    // The arrow function variable itself should be file-level
    // (though it would be filtered out by the function detection regex)
    
    // Variable inside arrow function should return null
    const insideArrow = detectVariableContext(content, 2);
    assert.strictEqual(insideArrow, null, 'Variable inside arrow function should return null');

    // Variable after arrow function should be file-level
    const afterArrow = detectVariableContext(content, 6);
    assert.strictEqual(afterArrow, 'file-level', 'Variable after arrow function should be file-level');
  });

  test('Method shorthand in object', () => {
    const content = `const obj = {
  method() {
    const temp = 42;
    return temp;
  }
};`;

    const context = detectVariableContext(content, 3);
    assert.strictEqual(context, null, 'Variable inside object method should return null');
  });

  test('IIFE (Immediately Invoked Function Expression)', () => {
    const content = `(function() {
  const temp = 42;
  console.log(temp);
})();

const FILE_VAR = "test";`;

    const iifeVar = detectVariableContext(content, 2);
    assert.strictEqual(iifeVar, null, 'Variable inside IIFE should return null');

    const fileVar = detectVariableContext(content, 6);
    assert.strictEqual(fileVar, 'file-level', 'Variable after IIFE should be file-level');
  });
});

