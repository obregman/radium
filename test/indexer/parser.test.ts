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

    test('should parse const variables', async () => {
      const code = `export const API_URL = "https://api.example.com";
const MAX_RETRIES = 3;
const config = { timeout: 5000 };`;
      const result = await parser.parseFile('test.ts', code);
      
      assert.ok(result, 'Result should not be null');
      
      const apiUrl = result!.symbols.find(s => s.name === 'API_URL');
      assert.ok(apiUrl, 'Should find API_URL constant');
      assert.strictEqual(apiUrl!.kind, 'variable', 'API_URL should be a variable');
      
      const maxRetries = result!.symbols.find(s => s.name === 'MAX_RETRIES');
      assert.ok(maxRetries, 'Should find MAX_RETRIES constant');
      
      const configVar = result!.symbols.find(s => s.name === 'config');
      assert.ok(configVar, 'Should find config constant');
    });

    test('should parse const arrow functions', async () => {
      const code = `export const processData = (data: string) => {
  return data.toUpperCase();
};

const handleClick = () => {
  console.log('clicked');
};

const add = (a: number, b: number) => a + b;`;
      const result = await parser.parseFile('test.ts', code);
      
      assert.ok(result, 'Result should not be null');
      
      const processData = result!.symbols.find(s => s.name === 'processData');
      assert.ok(processData, 'Should find processData arrow function');
      assert.strictEqual(processData!.kind, 'variable', 'Arrow function should be detected as variable');
      
      const handleClick = result!.symbols.find(s => s.name === 'handleClick');
      assert.ok(handleClick, 'Should find handleClick arrow function');
      
      const add = result!.symbols.find(s => s.name === 'add');
      assert.ok(add, 'Should find add arrow function');
    });

    test('should parse let and var variables', async () => {
      const code = `let counter = 0;
var globalVar = "test";
let isActive = true;`;
      const result = await parser.parseFile('test.ts', code);
      
      assert.ok(result, 'Result should not be null');
      
      const counter = result!.symbols.find(s => s.name === 'counter');
      assert.ok(counter, 'Should find counter variable');
      assert.strictEqual(counter!.kind, 'variable', 'counter should be a variable');
      
      const globalVar = result!.symbols.find(s => s.name === 'globalVar');
      assert.ok(globalVar, 'Should find globalVar variable');
      
      const isActive = result!.symbols.find(s => s.name === 'isActive');
      assert.ok(isActive, 'Should find isActive variable');
    });
  });

  suite('TSX Parsing', () => {
    test('should parse TSX exported function', async () => {
      const code = `export function Button() {
  return <button>Click me</button>;
}`;
      const result = await parser.parseFile('test.tsx', code);
      
      assert.ok(result, 'Result should not be null');
      assert.ok(result!.symbols.length > 0, 'Should find symbols');
      
      const funcSymbol = result!.symbols.find(s => s.kind === 'function');
      assert.ok(funcSymbol, 'Should find function symbol');
      assert.strictEqual(funcSymbol!.name, 'Button', 'Function name should be Button');
    });

    test('should parse TSX const arrow function component', async () => {
      const code = `export const Card = ({ title, content }: CardProps) => {
  return (
    <div className="card">
      <h2>{title}</h2>
      <p>{content}</p>
    </div>
  );
};

const Header = () => <header>My App</header>;`;
      const result = await parser.parseFile('test.tsx', code);
      
      assert.ok(result, 'Result should not be null');
      
      const card = result!.symbols.find(s => s.name === 'Card');
      assert.ok(card, 'Should find Card component');
      assert.strictEqual(card!.kind, 'variable', 'Arrow function component should be detected as variable');
      
      const header = result!.symbols.find(s => s.name === 'Header');
      assert.ok(header, 'Should find Header component');
    });

    test('should parse TSX interface', async () => {
      const code = `export interface ButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

interface CardProps {
  title: string;
  content: string;
}`;
      const result = await parser.parseFile('test.tsx', code);
      
      assert.ok(result, 'Result should not be null');
      
      const buttonProps = result!.symbols.find(s => s.name === 'ButtonProps');
      assert.ok(buttonProps, 'Should find ButtonProps interface');
      assert.strictEqual(buttonProps!.kind, 'interface', 'ButtonProps should be an interface');
      
      const cardProps = result!.symbols.find(s => s.name === 'CardProps');
      assert.ok(cardProps, 'Should find CardProps interface');
    });

    test('should parse TSX variables', async () => {
      const code = `export const DEFAULT_THEME = 'light';
const MAX_ITEMS = 10;
let currentPage = 1;

const config = {
  apiUrl: 'https://api.example.com',
  timeout: 5000
};`;
      const result = await parser.parseFile('test.tsx', code);
      
      assert.ok(result, 'Result should not be null');
      
      const theme = result!.symbols.find(s => s.name === 'DEFAULT_THEME');
      assert.ok(theme, 'Should find DEFAULT_THEME constant');
      
      const maxItems = result!.symbols.find(s => s.name === 'MAX_ITEMS');
      assert.ok(maxItems, 'Should find MAX_ITEMS constant');
      
      const currentPage = result!.symbols.find(s => s.name === 'currentPage');
      assert.ok(currentPage, 'Should find currentPage variable');
      
      const config = result!.symbols.find(s => s.name === 'config');
      assert.ok(config, 'Should find config object');
    });

    test('should parse TSX file with mixed symbols', async () => {
      const code = `import React from 'react';

export interface User {
  id: string;
  name: string;
}

export const UserCard = ({ user }: { user: User }) => {
  return (
    <div className="user-card">
      <h3>{user.name}</h3>
    </div>
  );
};

export function formatUserName(user: User): string {
  return user.name.toUpperCase();
}

export const API_ENDPOINT = '/api/users';`;
      const result = await parser.parseFile('test.tsx', code);
      
      assert.ok(result, 'Result should not be null');
      assert.ok(result!.symbols.length >= 4, 'Should find at least 4 symbols');
      
      const userInterface = result!.symbols.find(s => s.name === 'User' && s.kind === 'interface');
      assert.ok(userInterface, 'Should find User interface');
      
      const userCard = result!.symbols.find(s => s.name === 'UserCard');
      assert.ok(userCard, 'Should find UserCard component');
      
      const formatFunc = result!.symbols.find(s => s.name === 'formatUserName');
      assert.ok(formatFunc, 'Should find formatUserName function');
      
      const apiEndpoint = result!.symbols.find(s => s.name === 'API_ENDPOINT');
      assert.ok(apiEndpoint, 'Should find API_ENDPOINT constant');
    });

    test('should parse TSX class component', async () => {
      const code = `import React from 'react';

export class Counter extends React.Component {
  state = { count: 0 };
  
  increment() {
    this.setState({ count: this.state.count + 1 });
  }
  
  render() {
    return <button onClick={() => this.increment()}>{this.state.count}</button>;
  }
}`;
      const result = await parser.parseFile('test.tsx', code);
      
      assert.ok(result, 'Result should not be null');
      
      const classSymbol = result!.symbols.find(s => s.kind === 'class');
      assert.ok(classSymbol, 'Should find class symbol');
      assert.strictEqual(classSymbol!.name, 'Counter', 'Class name should be Counter');
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

  suite('Go Parsing', () => {
    test('should parse Go function', async () => {
      const code = `package main

func TestFunction() {
  return
}`;
      const result = await parser.parseFile('test.go', code);
      
      assert.ok(result, 'Result should not be null');
      assert.ok(result!.symbols.length > 0, 'Should find symbols');
      
      const funcSymbol = result!.symbols.find(s => s.kind === 'function' && s.name === 'TestFunction');
      assert.ok(funcSymbol, 'Should find function symbol');
      assert.strictEqual(funcSymbol!.name, 'TestFunction', 'Function name should be TestFunction');
    });

    test('should parse Go struct', async () => {
      const code = `package main

type User struct {
  ID   string
  Name string
}`;
      const result = await parser.parseFile('test.go', code);
      
      assert.ok(result, 'Result should not be null');
      
      const structSymbol = result!.symbols.find(s => s.kind === 'struct' && s.name === 'User');
      assert.ok(structSymbol, 'Should find struct symbol');
      assert.strictEqual(structSymbol!.name, 'User', 'Struct name should be User');
    });

    test('should parse Go interface', async () => {
      const code = `package main

type Reader interface {
  Read(p []byte) (n int, err error)
}`;
      const result = await parser.parseFile('test.go', code);
      
      assert.ok(result, 'Result should not be null');
      
      const interfaceSymbol = result!.symbols.find(s => s.kind === 'interface' && s.name === 'Reader');
      assert.ok(interfaceSymbol, 'Should find interface symbol');
      assert.strictEqual(interfaceSymbol!.name, 'Reader', 'Interface name should be Reader');
    });

    test('should parse Go method', async () => {
      const code = `package main

type User struct {
  Name string
}

func (u *User) GetName() string {
  return u.Name
}`;
      const result = await parser.parseFile('test.go', code);
      
      assert.ok(result, 'Result should not be null');
      
      const methodSymbol = result!.symbols.find(s => s.kind === 'function' && s.name === 'GetName');
      assert.ok(methodSymbol, 'Should find method symbol');
      assert.strictEqual(methodSymbol!.name, 'GetName', 'Method name should be GetName');
      assert.ok(methodSymbol!.fqname.includes('User'), 'Method FQN should include receiver type');
    });

    test('should parse Go const', async () => {
      const code = `package main

const (
  MaxRetries = 3
  Timeout = 5000
)`;
      const result = await parser.parseFile('test.go', code);
      
      assert.ok(result, 'Result should not be null');
      
      const maxRetries = result!.symbols.find(s => s.name === 'MaxRetries');
      assert.ok(maxRetries, 'Should find MaxRetries constant');
      assert.strictEqual(maxRetries!.kind, 'constant', 'MaxRetries should be a constant');
      
      const timeout = result!.symbols.find(s => s.name === 'Timeout');
      assert.ok(timeout, 'Should find Timeout constant');
    });

    test('should parse Go var', async () => {
      const code = `package main

var (
  counter int
  isActive bool
)`;
      const result = await parser.parseFile('test.go', code);
      
      assert.ok(result, 'Result should not be null');
      
      const counter = result!.symbols.find(s => s.name === 'counter');
      assert.ok(counter, 'Should find counter variable');
      assert.strictEqual(counter!.kind, 'variable', 'counter should be a variable');
      
      const isActive = result!.symbols.find(s => s.name === 'isActive');
      assert.ok(isActive, 'Should find isActive variable');
    });

    test('should parse Go short variable declaration', async () => {
      const code = `package main

func main() {
  x := 42
  name := "test"
}`;
      const result = await parser.parseFile('test.go', code);
      
      assert.ok(result, 'Result should not be null');
      
      const x = result!.symbols.find(s => s.name === 'x');
      assert.ok(x, 'Should find x variable');
      
      const name = result!.symbols.find(s => s.name === 'name');
      assert.ok(name, 'Should find name variable');
    });

    test('should parse Go imports', async () => {
      const code = `package main

import (
  "fmt"
  "net/http"
  customname "github.com/user/package"
)`;
      const result = await parser.parseFile('test.go', code);
      
      assert.ok(result, 'Result should not be null');
      assert.ok(result!.imports.length >= 3, 'Should find at least 3 imports');
      
      const fmtImport = result!.imports.find(i => i.source === 'fmt');
      assert.ok(fmtImport, 'Should find fmt import');
      
      const httpImport = result!.imports.find(i => i.source === 'net/http');
      assert.ok(httpImport, 'Should find net/http import');
      
      const customImport = result!.imports.find(i => i.source === 'github.com/user/package');
      assert.ok(customImport, 'Should find custom import');
      assert.ok(customImport!.names.includes('customname'), 'Should capture custom alias');
    });

    test('should parse Go type alias', async () => {
      const code = `package main

type UserID string
type Count int`;
      const result = await parser.parseFile('test.go', code);
      
      assert.ok(result, 'Result should not be null');
      
      const userID = result!.symbols.find(s => s.name === 'UserID');
      assert.ok(userID, 'Should find UserID type');
      assert.strictEqual(userID!.kind, 'type', 'UserID should be a type');
      
      const count = result!.symbols.find(s => s.name === 'Count');
      assert.ok(count, 'Should find Count type');
    });

    test('should parse Go file with mixed symbols', async () => {
      const code = `package api

import (
  "fmt"
  "net/http"
)

const APIVersion = "v1"

type Server struct {
  Port int
}

type Handler interface {
  ServeHTTP(w http.ResponseWriter, r *http.Request)
}

func (s *Server) Start() error {
  return nil
}

func NewServer(port int) *Server {
  return &Server{Port: port}
}`;
      const result = await parser.parseFile('test.go', code);
      
      assert.ok(result, 'Result should not be null');
      assert.ok(result!.symbols.length >= 5, 'Should find at least 5 symbols');
      
      const apiVersion = result!.symbols.find(s => s.name === 'APIVersion');
      assert.ok(apiVersion, 'Should find APIVersion constant');
      
      const server = result!.symbols.find(s => s.name === 'Server' && s.kind === 'struct');
      assert.ok(server, 'Should find Server struct');
      
      const handler = result!.symbols.find(s => s.name === 'Handler' && s.kind === 'interface');
      assert.ok(handler, 'Should find Handler interface');
      
      const start = result!.symbols.find(s => s.name === 'Start');
      assert.ok(start, 'Should find Start method');
      
      const newServer = result!.symbols.find(s => s.name === 'NewServer');
      assert.ok(newServer, 'Should find NewServer function');
    });

    test('should handle empty Go file', async () => {
      const code = 'package main';
      const result = await parser.parseFile('test.go', code);
      
      assert.ok(result, 'Result should not be null');
      // Package declaration doesn't create a symbol
      assert.ok(result!.symbols.length === 0, 'Empty package should have no symbols');
    });

    test('should parse Go multiple methods on same receiver', async () => {
      const code = `package main

type Calculator struct {
  value int
}

func (c *Calculator) Add(n int) {
  c.value += n
}

func (c *Calculator) Subtract(n int) {
  c.value -= n
}

func (c Calculator) GetValue() int {
  return c.value
}`;
      const result = await parser.parseFile('test.go', code);
      
      assert.ok(result, 'Result should not be null');
      
      const add = result!.symbols.find(s => s.name === 'Add');
      assert.ok(add, 'Should find Add method');
      assert.ok(add!.fqname.includes('Calculator'), 'Add should have Calculator in FQN');
      
      const subtract = result!.symbols.find(s => s.name === 'Subtract');
      assert.ok(subtract, 'Should find Subtract method');
      
      const getValue = result!.symbols.find(s => s.name === 'GetValue');
      assert.ok(getValue, 'Should find GetValue method');
    });
  });

  suite('Language Detection', () => {
    test('should detect TypeScript', () => {
      assert.strictEqual(parser.getLanguage('test.ts'), 'typescript');
      assert.strictEqual(parser.getLanguage('test.tsx'), 'tsx');  // TSX files use separate parser
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

    test('should detect Go', () => {
      assert.strictEqual(parser.getLanguage('test.go'), 'go');
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

