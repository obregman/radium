import * as assert from 'assert';
import { CodeParser } from '../../src/indexer/parser';

suite('Constructor Call Detection', () => {
  let parser: CodeParser;

  setup(() => {
    parser = new CodeParser();
  });

  test('should detect new ClassName() as a call', async () => {
    const code = `
export class MyClass {
  doSomething() {
    return 'hello';
  }
}

export function useMyClass() {
  const instance = new MyClass();
  return instance.doSomething();
}
`;
    const result = await parser.parseFile('test.ts', code);
    
    assert.ok(result, 'Result should not be null');
    assert.ok(result!.calls.length > 0, 'Should find call sites');
    
    // Should find "new MyClass" call
    const constructorCall = result!.calls.find(c => c.callee.includes('MyClass'));
    assert.ok(constructorCall, 'Should find constructor call to MyClass');
    
    console.log('Constructor call detected:', constructorCall?.callee);
  });

  test('should detect method calls', async () => {
    const code = `
export class MyClass {
  doSomething() {
    return 'hello';
  }
}

export function useMyClass() {
  const instance = new MyClass();
  return instance.doSomething();
}
`;
    const result = await parser.parseFile('test.ts', code);
    
    assert.ok(result, 'Result should not be null');
    
    // Should find method call
    const methodCall = result!.calls.find(c => c.callee.includes('doSomething'));
    assert.ok(methodCall, 'Should find method call to doSomething');
    
    console.log('Method call detected:', methodCall?.callee);
  });

  test('should handle multiple constructor calls', async () => {
    const code = `
export class ClassA {}
export class ClassB {}

export function createInstances() {
  const a = new ClassA();
  const b = new ClassB();
  return [a, b];
}
`;
    const result = await parser.parseFile('test.ts', code);
    
    assert.ok(result, 'Result should not be null');
    
    // Constructor calls no longer have "new " prefix, they're just the class name
    const constructorCalls = result!.calls.filter(c => 
      c.callee === 'ClassA' || c.callee === 'ClassB'
    );
    assert.ok(constructorCalls.length >= 2, `Should find at least 2 constructor calls, found ${constructorCalls.length}`);
    
    console.log('Constructor calls found:', constructorCalls.map(c => c.callee));
  });
});

