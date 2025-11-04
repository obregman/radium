import Parser from 'tree-sitter';
import * as fs from 'fs';
import * as crypto from 'crypto';

// Tree-sitter language imports
// eslint-disable-next-line @typescript-eslint/no-var-requires
const TypeScript = require('tree-sitter-typescript').typescript;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const JavaScript = require('tree-sitter-javascript');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Python = require('tree-sitter-python');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const CSharp = require('tree-sitter-c-sharp');

export interface ParsedSymbol {
  kind: string;
  name: string;
  fqname: string;
  range: { start: number; end: number };
}

export interface ImportDeclaration {
  source: string;
  names: string[];
  range: { start: number; end: number };
}

export interface CallSite {
  callee: string;
  range: { start: number; end: number };
}

export interface ParseResult {
  symbols: ParsedSymbol[];
  imports: ImportDeclaration[];
  calls: CallSite[];
  hash: string;
}

export class CodeParser {
  private parsers: Map<string, Parser> = new Map();

  constructor() {
    this.initParsers();
  }

  private initParsers() {
    // TypeScript parser
    const tsParser = new Parser();
    tsParser.setLanguage(TypeScript);
    this.parsers.set('typescript', tsParser);
    this.parsers.set('ts', tsParser);
    this.parsers.set('tsx', tsParser);

    // JavaScript parser
    const jsParser = new Parser();
    jsParser.setLanguage(JavaScript);
    this.parsers.set('javascript', jsParser);
    this.parsers.set('js', jsParser);
    this.parsers.set('jsx', jsParser);

    // Python parser
    const pyParser = new Parser();
    pyParser.setLanguage(Python);
    this.parsers.set('python', pyParser);
    this.parsers.set('py', pyParser);

    // C# parser
    try {
      const csParser = new Parser();
      csParser.setLanguage(CSharp);
      this.parsers.set('csharp', csParser);
      this.parsers.set('cs', csParser);
    } catch (error) {
      console.error('[Radium] Failed to initialize C# parser:', error);
    }
  }

  getLanguage(filePath: string): string | undefined {
    const ext = filePath.split('.').pop()?.toLowerCase();
    if (!ext) return undefined;

    const langMap: Record<string, string> = {
      'ts': 'typescript',
      'tsx': 'typescript',
      'js': 'javascript',
      'jsx': 'javascript',
      'py': 'python',
      'cs': 'csharp'
    };

    return langMap[ext];
  }

  private treeHasErrors(node: Parser.SyntaxNode): boolean {
    // Check if this node is an ERROR node
    if (node.type === 'ERROR' || node.isMissing) {
      return true;
    }
    
    // Recursively check children
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child && this.treeHasErrors(child)) {
        return true;
      }
    }
    
    return false;
  }

  async parseFile(filePath: string, content?: string): Promise<ParseResult | null> {
    const lang = this.getLanguage(filePath);
    if (!lang) {
      console.warn(`[Radium] No language detected for file: ${filePath}`);
      return null;
    }

    const code = content ?? await fs.promises.readFile(filePath, 'utf-8');
    const hash = crypto.createHash('sha256').update(code).digest('hex');

    const parser = this.parsers.get(lang);
    if (!parser) {
      console.warn(`[Radium] No parser available for language: ${lang} (file: ${filePath})`);
      return null;
    }

    console.log(`[Radium Parser] Parsing ${filePath} as ${lang}, length: ${code.length}`);

    try {
      // Validate input
      if (typeof code !== 'string') {
        console.error(`[Radium] Invalid code type for ${filePath}: ${typeof code}`);
        return { symbols: [], imports: [], calls: [], hash };
      }
      
      if (code.length === 0) {
        console.warn(`[Radium] Empty file: ${filePath}`);
        return { symbols: [], imports: [], calls: [], hash };
      }

      // Skip very large files that might cause parser issues
      const MAX_FILE_SIZE = 200000; // 200KB
      if (code.length > MAX_FILE_SIZE) {
        console.warn(`[Radium] Skipping large file ${filePath} (${code.length} bytes, max: ${MAX_FILE_SIZE})`);
        return { symbols: [], imports: [], calls: [], hash };
      }

      // Check for null bytes or other invalid characters that break tree-sitter
      if (code.includes('\0')) {
        console.warn(`[Radium] File contains null bytes, skipping: ${filePath}`);
        return { symbols: [], imports: [], calls: [], hash };
      }

      let tree;
      try {
        tree = parser.parse(code);
      } catch (parseError) {
        // Tree-sitter can fail on certain valid TypeScript syntax
        // This is a known limitation - try to extract what we can from the code anyway
        console.warn(`[Radium] Tree-sitter parse failed for ${filePath} (${code.length} bytes), attempting fallback extraction`);
        console.warn(`[Radium] Parse error:`, parseError);
        
        // Try a simple regex-based extraction as fallback
        const symbols: ParsedSymbol[] = [];
        try {
          this.extractSymbolsWithRegex(code, symbols, filePath);
          console.log(`[Radium Parser] Fallback extracted ${symbols.length} symbols from ${filePath}`);
          return { symbols, imports: [], calls: [], hash };
        } catch (fallbackError) {
          console.warn(`[Radium] Fallback extraction also failed:`, fallbackError);
          return { symbols: [], imports: [], calls: [], hash };
        }
      }

      if (!tree || !tree.rootNode) {
        console.warn(`[Radium] Invalid parse tree for ${filePath}`);
        return { symbols: [], imports: [], calls: [], hash };
      }

      // Check if the tree has syntax errors
      const hasErrors = this.treeHasErrors(tree.rootNode);
      if (hasErrors) {
        console.warn(`[Radium] Parse tree has syntax errors for ${filePath}, attempting extraction anyway`);
      }

      const symbols: ParsedSymbol[] = [];
      const imports: ImportDeclaration[] = [];
      const calls: CallSite[] = [];

      try {
        if (lang === 'typescript' || lang === 'javascript') {
          this.extractTypeScriptSymbols(tree.rootNode, code, symbols, imports, calls, filePath);
        } else if (lang === 'python') {
          this.extractPythonSymbols(tree.rootNode, code, symbols, imports, calls, filePath);
        } else if (lang === 'csharp') {
          this.extractCSharpSymbols(tree.rootNode, code, symbols, imports, calls, filePath);
        }
      } catch (extractError) {
        console.warn(`[Radium] Symbol extraction failed for ${filePath}:`, extractError);
        // Return partial results if any were extracted before the error
      }

      console.log(`[Radium Parser] Extracted ${symbols.length} symbols, ${imports.length} imports, ${calls.length} calls from ${filePath}`);
      
      return { symbols, imports, calls, hash };
    } catch (error) {
      console.error(`[Radium] Unexpected error parsing file ${filePath}:`, error);
      console.error(`[Radium] Code length: ${code?.length}, type: ${typeof code}`);
      return { symbols: [], imports: [], calls: [], hash };
    }
  }

  private extractTypeScriptSymbols(
    node: Parser.SyntaxNode,
    code: string,
    symbols: ParsedSymbol[],
    imports: ImportDeclaration[],
    calls: CallSite[],
    filePath: string,
    namespace: string = ''
  ) {
    if (node.type === 'function_declaration' || node.type === 'method_definition') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const name = code.slice(nameNode.startIndex, nameNode.endIndex);
        // Special handling for constructors
        const isConstructor = name === 'constructor';
        symbols.push({
          kind: isConstructor ? 'constructor' : 'function',
          name,
          fqname: namespace ? `${namespace}.${name}` : name,
          range: { start: node.startIndex, end: node.endIndex }
        });
      }
    } else if (node.type === 'class_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const name = code.slice(nameNode.startIndex, nameNode.endIndex);
        const fqname = namespace ? `${namespace}.${name}` : name;
        symbols.push({
          kind: 'class',
          name,
          fqname,
          range: { start: node.startIndex, end: node.endIndex }
        });
        // Recurse into class body with new namespace
        const bodyNode = node.childForFieldName('body');
        if (bodyNode) {
          this.extractTypeScriptSymbols(bodyNode, code, symbols, imports, calls, filePath, fqname);
        }
      }
    } else if (node.type === 'interface_declaration' || node.type === 'type_alias_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const name = code.slice(nameNode.startIndex, nameNode.endIndex);
        symbols.push({
          kind: node.type === 'interface_declaration' ? 'interface' : 'type',
          name,
          fqname: namespace ? `${namespace}.${name}` : name,
          range: { start: node.startIndex, end: node.endIndex }
        });
      }
    } else if (node.type === 'import_statement') {
      const sourceNode = node.childForFieldName('source');
      if (sourceNode) {
        const source = code.slice(sourceNode.startIndex, sourceNode.endIndex).replace(/['"]/g, '');
        const names: string[] = [];
        
        // Extract imported names
        for (const child of node.children) {
          if (child.type === 'import_clause') {
            this.extractImportNames(child, code, names);
          }
        }

        imports.push({
          source,
          names,
          range: { start: node.startIndex, end: node.endIndex }
        });
      }
    } else if (node.type === 'call_expression') {
      const funcNode = node.childForFieldName('function');
      if (funcNode) {
        const callee = code.slice(funcNode.startIndex, funcNode.endIndex);
        calls.push({
          callee,
          range: { start: node.startIndex, end: node.endIndex }
        });
      }
    }

    // Recurse to children
    for (const child of node.children) {
      this.extractTypeScriptSymbols(child, code, symbols, imports, calls, filePath, namespace);
    }
  }

  private extractImportNames(node: Parser.SyntaxNode, code: string, names: string[]) {
    if (node.type === 'identifier') {
      names.push(code.slice(node.startIndex, node.endIndex));
    } else if (node.type === 'named_imports') {
      for (const child of node.children) {
        if (child.type === 'import_specifier') {
          const nameNode = child.childForFieldName('name');
          if (nameNode) {
            names.push(code.slice(nameNode.startIndex, nameNode.endIndex));
          }
        }
      }
    }

    for (const child of node.children) {
      this.extractImportNames(child, code, names);
    }
  }

  private extractPythonSymbols(
    node: Parser.SyntaxNode,
    code: string,
    symbols: ParsedSymbol[],
    imports: ImportDeclaration[],
    calls: CallSite[],
    filePath: string,
    namespace: string = ''
  ) {
    if (node.type === 'function_definition') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const name = code.slice(nameNode.startIndex, nameNode.endIndex);
        symbols.push({
          kind: 'function',
          name,
          fqname: namespace ? `${namespace}.${name}` : name,
          range: { start: node.startIndex, end: node.endIndex }
        });
      }
    } else if (node.type === 'class_definition') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const name = code.slice(nameNode.startIndex, nameNode.endIndex);
        const fqname = namespace ? `${namespace}.${name}` : name;
        symbols.push({
          kind: 'class',
          name,
          fqname,
          range: { start: node.startIndex, end: node.endIndex }
        });
        // Recurse into class body with new namespace
        const bodyNode = node.childForFieldName('body');
        if (bodyNode) {
          this.extractPythonSymbols(bodyNode, code, symbols, imports, calls, filePath, fqname);
        }
      }
    } else if (node.type === 'import_statement' || node.type === 'import_from_statement') {
      const names: string[] = [];
      let source = '';

      if (node.type === 'import_from_statement') {
        const moduleNode = node.childForFieldName('module_name');
        if (moduleNode) {
          source = code.slice(moduleNode.startIndex, moduleNode.endIndex);
        }
      }

      for (const child of node.children) {
        if (child.type === 'dotted_name' && node.type === 'import_statement') {
          source = code.slice(child.startIndex, child.endIndex);
          names.push(source);
        } else if (child.type === 'aliased_import') {
          const nameNode = child.childForFieldName('name');
          if (nameNode) {
            names.push(code.slice(nameNode.startIndex, nameNode.endIndex));
          }
        }
      }

      if (source || names.length > 0) {
        imports.push({
          source,
          names,
          range: { start: node.startIndex, end: node.endIndex }
        });
      }
    } else if (node.type === 'call') {
      const funcNode = node.childForFieldName('function');
      if (funcNode) {
        const callee = code.slice(funcNode.startIndex, funcNode.endIndex);
        calls.push({
          callee,
          range: { start: node.startIndex, end: node.endIndex }
        });
      }
    }

    // Recurse to children
    for (const child of node.children) {
      this.extractPythonSymbols(child, code, symbols, imports, calls, filePath, namespace);
    }
  }

  private extractCSharpSymbols(
    node: Parser.SyntaxNode,
    code: string,
    symbols: ParsedSymbol[],
    imports: ImportDeclaration[],
    calls: CallSite[],
    filePath: string,
    namespace: string = ''
  ) {
    // Method declarations
    if (node.type === 'method_declaration' || node.type === 'local_function_statement') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const name = code.slice(nameNode.startIndex, nameNode.endIndex);
        symbols.push({
          kind: 'function',
          name,
          fqname: namespace ? `${namespace}.${name}` : name,
          range: { start: node.startIndex, end: node.endIndex }
        });
      }
    }
    // Class declarations
    else if (node.type === 'class_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const name = code.slice(nameNode.startIndex, nameNode.endIndex);
        const fqname = namespace ? `${namespace}.${name}` : name;
        symbols.push({
          kind: 'class',
          name,
          fqname,
          range: { start: node.startIndex, end: node.endIndex }
        });
        // Recurse into class body with new namespace
        const bodyNode = node.childForFieldName('body');
        if (bodyNode) {
          this.extractCSharpSymbols(bodyNode, code, symbols, imports, calls, filePath, fqname);
        }
      }
    }
    // Interface declarations
    else if (node.type === 'interface_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const name = code.slice(nameNode.startIndex, nameNode.endIndex);
        symbols.push({
          kind: 'interface',
          name,
          fqname: namespace ? `${namespace}.${name}` : name,
          range: { start: node.startIndex, end: node.endIndex }
        });
      }
    }
    // Struct declarations
    else if (node.type === 'struct_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const name = code.slice(nameNode.startIndex, nameNode.endIndex);
        symbols.push({
          kind: 'class',
          name,
          fqname: namespace ? `${namespace}.${name}` : name,
          range: { start: node.startIndex, end: node.endIndex }
        });
      }
    }
    // Enum declarations
    else if (node.type === 'enum_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const name = code.slice(nameNode.startIndex, nameNode.endIndex);
        symbols.push({
          kind: 'type',
          name,
          fqname: namespace ? `${namespace}.${name}` : name,
          range: { start: node.startIndex, end: node.endIndex }
        });
      }
    }
    // Property declarations
    else if (node.type === 'property_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const name = code.slice(nameNode.startIndex, nameNode.endIndex);
        symbols.push({
          kind: 'variable',
          name,
          fqname: namespace ? `${namespace}.${name}` : name,
          range: { start: node.startIndex, end: node.endIndex }
        });
      }
    }
    // Field declarations
    else if (node.type === 'field_declaration') {
      // Field declarations can have multiple variables
      for (const child of node.children) {
        if (child.type === 'variable_declaration') {
          const declaratorNode = child.childForFieldName('declarator');
          if (declaratorNode) {
            const nameNode = declaratorNode.childForFieldName('name');
            if (nameNode) {
              const name = code.slice(nameNode.startIndex, nameNode.endIndex);
              symbols.push({
                kind: 'variable',
                name,
                fqname: namespace ? `${namespace}.${name}` : name,
                range: { start: node.startIndex, end: node.endIndex }
              });
            }
          }
        }
      }
    }
    // Using directives (imports)
    else if (node.type === 'using_directive') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const source = code.slice(nameNode.startIndex, nameNode.endIndex);
        imports.push({
          source,
          names: [source],
          range: { start: node.startIndex, end: node.endIndex }
        });
      }
    }
    // Invocation expressions (function calls)
    else if (node.type === 'invocation_expression') {
      const funcNode = node.childForFieldName('function');
      if (funcNode) {
        const callee = code.slice(funcNode.startIndex, funcNode.endIndex);
        calls.push({
          callee,
          range: { start: node.startIndex, end: node.endIndex }
        });
      }
    }
    // Namespace declarations
    else if (node.type === 'namespace_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const name = code.slice(nameNode.startIndex, nameNode.endIndex);
        const newNamespace = namespace ? `${namespace}.${name}` : name;
        // Recurse into namespace body with new namespace
        const bodyNode = node.childForFieldName('body');
        if (bodyNode) {
          this.extractCSharpSymbols(bodyNode, code, symbols, imports, calls, filePath, newNamespace);
        }
        return; // Don't recurse to children again
      }
    }

    // Recurse to children
    for (const child of node.children) {
      this.extractCSharpSymbols(child, code, symbols, imports, calls, filePath, namespace);
    }
  }

  // Fallback regex-based symbol extraction for when tree-sitter fails
  private extractSymbolsWithRegex(code: string, symbols: ParsedSymbol[], filePath: string) {
    const lines = code.split('\n');
    
    // Extract functions: function name(...) or async function name(...)
    const functionRegex = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g;
    let match;
    while ((match = functionRegex.exec(code)) !== null) {
      const name = match[1];
      const startIndex = match.index;
      symbols.push({
        kind: 'function',
        name,
        fqname: name,
        range: { start: startIndex, end: startIndex + match[0].length }
      });
    }
    
    // Extract classes: class ClassName
    const classRegex = /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/g;
    while ((match = classRegex.exec(code)) !== null) {
      const name = match[1];
      const startIndex = match.index;
      symbols.push({
        kind: 'class',
        name,
        fqname: name,
        range: { start: startIndex, end: startIndex + match[0].length }
      });
    }
    
    // Extract interfaces: interface InterfaceName
    const interfaceRegex = /(?:export\s+)?interface\s+(\w+)/g;
    while ((match = interfaceRegex.exec(code)) !== null) {
      const name = match[1];
      const startIndex = match.index;
      symbols.push({
        kind: 'interface',
        name,
        fqname: name,
        range: { start: startIndex, end: startIndex + match[0].length }
      });
    }
    
    // Extract type aliases: type TypeName =
    const typeRegex = /(?:export\s+)?type\s+(\w+)\s*=/g;
    while ((match = typeRegex.exec(code)) !== null) {
      const name = match[1];
      const startIndex = match.index;
      symbols.push({
        kind: 'type',
        name,
        fqname: name,
        range: { start: startIndex, end: startIndex + match[0].length }
      });
    }
    
    // Extract const: const NAME =
    const constRegex = /(?:export\s+)?const\s+(\w+)\s*=/g;
    while ((match = constRegex.exec(code)) !== null) {
      const name = match[1];
      const startIndex = match.index;
      symbols.push({
        kind: 'constant',
        name,
        fqname: name,
        range: { start: startIndex, end: startIndex + match[0].length }
      });
    }
    
    console.log(`[Radium] Regex extraction found: ${symbols.length} symbols`);
  }
}

