import * as assert from 'assert';
import { CodeParser } from '../../src/indexer/parser';

suite('CodeParser Test Suite', () => {
  let parser: CodeParser;

  setup(() => {
    parser = new CodeParser();
  });

  suite('TypeScript Parsing', () => {
    test('should parse exported class', async () => {
      const code = `export class TestClass {
  method() {}
}`;
      const result = await parser.parseFile('test.ts', code);
      
      assert.ok(result, 'Result should not be null');
      assert.ok(result!.symbols.length > 0, 'Should find symbols');
      
      const classSymbol = result!.symbols.find(s => s.kind === 'class');
      assert.ok(classSymbol, 'Should find class symbol');
      assert.strictEqual(classSymbol!.name, 'TestClass', 'Class name should be TestClass');
    });

    test('should parse exported function', async () => {
      const code = `export function testFunction() {
  return 42;
}`;
      const result = await parser.parseFile('test.ts', code);
      
      assert.ok(result, 'Result should not be null');
      assert.ok(result!.symbols.length > 0, 'Should find symbols');
      
      const funcSymbol = result!.symbols.find(s => s.kind === 'function');
      assert.ok(funcSymbol, 'Should find function symbol');
      assert.strictEqual(funcSymbol!.name, 'testFunction', 'Function name should be testFunction');
    });

    test('should parse interface', async () => {
      const code = `export interface User {
  id: string;
  name: string;
}`;
      const result = await parser.parseFile('test.ts', code);
      
      assert.ok(result, 'Result should not be null');
      
      const interfaceSymbol = result!.symbols.find(s => s.kind === 'interface');
      assert.ok(interfaceSymbol, 'Should find interface symbol');
      assert.strictEqual(interfaceSymbol!.name, 'User', 'Interface name should be User');
    });

    test('should parse type alias', async () => {
      const code = `export type UserId = string;`;
      const result = await parser.parseFile('test.ts', code);
      
      assert.ok(result, 'Result should not be null');
      
      const typeSymbol = result!.symbols.find(s => s.kind === 'type');
      assert.ok(typeSymbol, 'Should find type symbol');
      assert.strictEqual(typeSymbol!.name, 'UserId', 'Type name should be UserId');
    });

    test('should handle empty file', async () => {
      const code = '';
      const result = await parser.parseFile('test.ts', code);
      
      assert.ok(result, 'Result should not be null');
      assert.strictEqual(result!.symbols.length, 0, 'Empty file should have no symbols');
    });

    test('should handle file with only comments', async () => {
      const code = `// Comment\n/* Block comment */`;
      const result = await parser.parseFile('test.ts', code);
      
      assert.ok(result, 'Result should not be null');
      assert.strictEqual(result!.symbols.length, 0, 'Comment-only file should have no symbols');
    });
  });

  suite('C# Parsing', () => {
    test('should parse C# class', async () => {
      const code = `public class TestClass {
  public void Method() {}
}`;
      const result = await parser.parseFile('test.cs', code);
      
      assert.ok(result, 'Result should not be null');
      assert.ok(result!.symbols.length > 0, 'Should find symbols');
      
      const classSymbol = result!.symbols.find(s => s.kind === 'class');
      assert.ok(classSymbol, 'Should find class symbol');
      assert.strictEqual(classSymbol!.name, 'TestClass', 'Class name should be TestClass');
    });

    test('should parse C# interface', async () => {
      const code = `public interface IUser {
  string Name { get; set; }
}`;
      const result = await parser.parseFile('test.cs', code);
      
      assert.ok(result, 'Result should not be null');
      
      const interfaceSymbol = result!.symbols.find(s => s.kind === 'interface');
      assert.ok(interfaceSymbol, 'Should find interface symbol');
      assert.strictEqual(interfaceSymbol!.name, 'IUser', 'Interface name should be IUser');
    });
  });

  suite('Python Parsing', () => {
    test('should parse Python class', async () => {
      const code = `class TestClass:
    def method(self):
        pass`;
      const result = await parser.parseFile('test.py', code);
      
      assert.ok(result, 'Result should not be null');
      assert.ok(result!.symbols.length > 0, 'Should find symbols');
      
      const classSymbol = result!.symbols.find(s => s.kind === 'class');
      assert.ok(classSymbol, 'Should find class symbol');
      assert.strictEqual(classSymbol!.name, 'TestClass', 'Class name should be TestClass');
    });

    test('should parse Python function', async () => {
      const code = `def test_function():
    return 42`;
      const result = await parser.parseFile('test.py', code);
      
      assert.ok(result, 'Result should not be null');
      assert.ok(result!.symbols.length > 0, 'Should find symbols');
      
      const funcSymbol = result!.symbols.find(s => s.kind === 'function');
      assert.ok(funcSymbol, 'Should find function symbol');
      assert.strictEqual(funcSymbol!.name, 'test_function', 'Function name should be test_function');
    });
  });

  suite('Language Detection', () => {
    test('should detect TypeScript', () => {
      assert.strictEqual(parser.getLanguage('test.ts'), 'typescript');
      assert.strictEqual(parser.getLanguage('test.tsx'), 'typescript');
    });

    test('should detect JavaScript', () => {
      assert.strictEqual(parser.getLanguage('test.js'), 'javascript');
      assert.strictEqual(parser.getLanguage('test.jsx'), 'javascript');
    });

    test('should detect Python', () => {
      assert.strictEqual(parser.getLanguage('test.py'), 'python');
    });

    test('should detect C#', () => {
      assert.strictEqual(parser.getLanguage('test.cs'), 'csharp');
    });

    test('should return undefined for unsupported files', () => {
      assert.strictEqual(parser.getLanguage('test.txt'), undefined);
      assert.strictEqual(parser.getLanguage('test.md'), undefined);
    });
  });

  suite('Error Handling', () => {
    test('should handle null bytes', async () => {
      const code = 'export class Test\0Class {}';
      const result = await parser.parseFile('test.ts', code);
      
      assert.ok(result, 'Should return result');
      assert.strictEqual(result!.symbols.length, 0, 'Should skip files with null bytes');
    });

    test('should return null for unsupported file types', async () => {
      const code = 'Some text';
      const result = await parser.parseFile('test.txt', code);
      
      assert.strictEqual(result, null, 'Should return null for unsupported types');
    });
  });

  suite('Regex Fallback Extraction', () => {
    test('should extract symbols via tree-sitter or regex fallback', async () => {
      // Simple code that tree-sitter should handle successfully
      const code = `
export class ChatService {
  async sendMessage() {}
}

export interface Message {
  id: string;
}

export type MessageId = string;

export const API_URL = "https://api.example.com";

export function processMessage() {}
`;
      const result = await parser.parseFile('test.ts', code);
      
      assert.ok(result, 'Should return result');
      // Should find symbols either via tree-sitter or regex fallback
      assert.ok(result!.symbols.length >= 4, 'Should find at least 4 symbols');
      
      const classSymbol = result!.symbols.find(s => s.name === 'ChatService');
      assert.ok(classSymbol, 'Should find ChatService class');
      
      const interfaceSymbol = result!.symbols.find(s => s.name === 'Message');
      assert.ok(interfaceSymbol, 'Should find Message interface');
      
      const typeSymbol = result!.symbols.find(s => s.name === 'MessageId');
      assert.ok(typeSymbol, 'Should find MessageId type');
      
      const funcSymbol = result!.symbols.find(s => s.name === 'processMessage');
      assert.ok(funcSymbol, 'Should find processMessage function');
    });
  });
});

