import Parser from 'tree-sitter';
import * as fs from 'fs';
import * as crypto from 'crypto';

// Tree-sitter language imports
// eslint-disable-next-line @typescript-eslint/no-var-requires
const TypeScript = require('tree-sitter-typescript').typescript;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const TSX = require('tree-sitter-typescript').tsx;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const JavaScript = require('tree-sitter-javascript');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Python = require('tree-sitter-python');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const CSharp = require('tree-sitter-c-sharp');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Go = require('tree-sitter-go');

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

    // TSX parser (separate from TypeScript for proper JSX support)
    const tsxParser = new Parser();
    tsxParser.setLanguage(TSX);
    this.parsers.set('tsx', tsxParser);

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

    // Go parser
    try {
      const goParser = new Parser();
      goParser.setLanguage(Go);
      this.parsers.set('go', goParser);
    } catch (error) {
      console.error('[Radium] Failed to initialize Go parser:', error);
    }
  }

  getLanguage(filePath: string): string | undefined {
    const ext = filePath.split('.').pop()?.toLowerCase();
    if (!ext) return undefined;

    const langMap: Record<string, string> = {
      'ts': 'typescript',
      'tsx': 'tsx',  // TSX files need the TSX parser for proper JSX support
      'js': 'javascript',
      'jsx': 'javascript',
      'py': 'python',
      'cs': 'csharp',
      'go': 'go'
    };

    const language = langMap[ext];
    
    // Log for debugging .xaml.cs files
    if (filePath.includes('.xaml.cs')) {
      console.log(`[Radium Parser] .xaml.cs file detected: ${filePath}, extension: ${ext}, language: ${language}`);
    }

    return language;
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
        if (lang === 'typescript' || lang === 'tsx' || lang === 'javascript') {
          this.extractTypeScriptSymbols(tree.rootNode, code, symbols, imports, calls, filePath);
        } else if (lang === 'python') {
          this.extractPythonSymbols(tree.rootNode, code, symbols, imports, calls, filePath);
        } else if (lang === 'csharp') {
          this.extractCSharpSymbols(tree.rootNode, code, symbols, imports, calls, filePath);
        } else if (lang === 'go') {
          this.extractGoSymbols(tree.rootNode, code, symbols, imports, calls, filePath);
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
    } else if (node.type === 'export_statement') {
      // Handle exported declarations (common in TSX/TS files)
      // The actual declaration is in the 'declaration' field
      const declarationNode = node.childForFieldName('declaration');
      if (declarationNode) {
        // Process the exported declaration (function, class, interface, etc.)
        this.extractTypeScriptSymbols(declarationNode, code, symbols, imports, calls, filePath, namespace);
      }
      // Don't recurse to all children since we handled the declaration
      return;
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
    } else if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
      // Handle const, let, var declarations
      for (const child of node.children) {
        if (child.type === 'variable_declarator') {
          const nameNode = child.childForFieldName('name');
          if (nameNode) {
            const name = code.slice(nameNode.startIndex, nameNode.endIndex);
            symbols.push({
              kind: 'variable',
              name,
              fqname: namespace ? `${namespace}.${name}` : name,
              range: { start: child.startIndex, end: child.endIndex }
            });
          }
        }
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
    // Constructor declarations
    else if (node.type === 'constructor_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const name = code.slice(nameNode.startIndex, nameNode.endIndex);
        symbols.push({
          kind: 'constructor',
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
        return; // Don't recurse to children again
      }
    }
    // Interface declarations
    else if (node.type === 'interface_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const name = code.slice(nameNode.startIndex, nameNode.endIndex);
        const fqname = namespace ? `${namespace}.${name}` : name;
        symbols.push({
          kind: 'interface',
          name,
          fqname,
          range: { start: node.startIndex, end: node.endIndex }
        });
        // Recurse into interface body with new namespace
        const bodyNode = node.childForFieldName('body');
        if (bodyNode) {
          this.extractCSharpSymbols(bodyNode, code, symbols, imports, calls, filePath, fqname);
        }
        return; // Don't recurse to children again
      }
    }
    // Struct declarations
    else if (node.type === 'struct_declaration') {
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
        // Recurse into struct body with new namespace
        const bodyNode = node.childForFieldName('body');
        if (bodyNode) {
          this.extractCSharpSymbols(bodyNode, code, symbols, imports, calls, filePath, fqname);
        }
        return; // Don't recurse to children again
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
    // Delegate declarations
    else if (node.type === 'delegate_declaration') {
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
    // Event declarations
    else if (node.type === 'event_declaration' || node.type === 'event_field_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const name = code.slice(nameNode.startIndex, nameNode.endIndex);
        symbols.push({
          kind: 'variable',
          name,
          fqname: namespace ? `${namespace}.${name}` : name,
          range: { start: node.startIndex, end: node.endIndex }
        });
      } else {
        // event_field_declaration may have variable_declaration children
        for (const child of node.children) {
          if (child.type === 'variable_declaration') {
            const declaratorNode = child.childForFieldName('declarator');
            if (declaratorNode && declaratorNode.type === 'variable_declarator') {
              const varNameNode = declaratorNode.childForFieldName('name');
              if (varNameNode) {
                const name = code.slice(varNameNode.startIndex, varNameNode.endIndex);
                symbols.push({
                  kind: 'variable',
                  name,
                  fqname: namespace ? `${namespace}.${name}` : name,
                  range: { start: node.startIndex, end: node.endIndex }
                });
              }
            }
          } else if (child.type === 'variable_declarator') {
            // Sometimes the declarator is a direct child
            const varNameNode = child.childForFieldName('name');
            if (varNameNode) {
              const name = code.slice(varNameNode.startIndex, varNameNode.endIndex);
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
    // Indexer declarations
    else if (node.type === 'indexer_declaration') {
      // Indexers don't have a name field, they use 'this' keyword
      // We'll name them based on their signature or just 'this'
      symbols.push({
        kind: 'function',
        name: 'this',
        fqname: namespace ? `${namespace}.this` : 'this',
        range: { start: node.startIndex, end: node.endIndex }
      });
    }
    // Operator overload declarations
    else if (node.type === 'operator_declaration' || node.type === 'conversion_operator_declaration') {
      // Operator declarations have an operator token
      let operatorName = '';
      
      // Look for the operator symbol or conversion keyword
      for (const child of node.children) {
        // For conversion operators (implicit/explicit)
        if (child.type === 'implicit_keyword' || child.type === 'explicit_keyword') {
          operatorName = code.slice(child.startIndex, child.endIndex);
          break;
        }
        // For regular operators, look for specific operator symbols
        if (child.type === '+' || child.type === '-' || child.type === '*' || child.type === '/' ||
            child.type === '==' || child.type === '!=' || child.type === '<' || child.type === '>' ||
            child.type === '<=' || child.type === '>=' || child.type === '!' || child.type === '~' ||
            child.type === '++' || child.type === '--' || child.type === '&' || child.type === '|' ||
            child.type === '^' || child.type === '<<' || child.type === '>>' || child.type === '%' ||
            child.type === 'true' || child.type === 'false') {
          operatorName = code.slice(child.startIndex, child.endIndex);
          break;
        }
        // Generic check for any node that looks like an operator
        const text = code.slice(child.startIndex, child.endIndex);
        if (text && text.length <= 3 && /^[+\-*\/%&|^~!<>=]+$/.test(text)) {
          operatorName = text;
          break;
        }
      }
      
      if (!operatorName) {
        operatorName = 'unknown';
      }
      
      symbols.push({
        kind: 'function',
        name: `operator ${operatorName}`,
        fqname: namespace ? `${namespace}.operator ${operatorName}` : `operator ${operatorName}`,
        range: { start: node.startIndex, end: node.endIndex }
      });
    }
    // Destructor/Finalizer declarations
    else if (node.type === 'destructor_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const name = code.slice(nameNode.startIndex, nameNode.endIndex);
        symbols.push({
          kind: 'function',
          name: `~${name}`,
          fqname: namespace ? `${namespace}.~${name}` : `~${name}`,
          range: { start: node.startIndex, end: node.endIndex }
        });
      }
    }
    // Record declarations (C# 9+)
    else if (node.type === 'record_declaration') {
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
        // Recurse into record body with new namespace
        const bodyNode = node.childForFieldName('body');
        if (bodyNode) {
          this.extractCSharpSymbols(bodyNode, code, symbols, imports, calls, filePath, fqname);
        }
        return; // Don't recurse to children again
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

  private extractGoSymbols(
    node: Parser.SyntaxNode,
    code: string,
    symbols: ParsedSymbol[],
    imports: ImportDeclaration[],
    calls: CallSite[],
    filePath: string,
    namespace: string = ''
  ) {
    // Function declarations
    if (node.type === 'function_declaration') {
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
    // Method declarations (functions with receivers)
    else if (node.type === 'method_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const name = code.slice(nameNode.startIndex, nameNode.endIndex);
        // Try to get receiver type for better FQN
        const receiverNode = node.childForFieldName('receiver');
        let receiverType = '';
        if (receiverNode) {
          // Extract receiver type from parameter list
          for (const child of receiverNode.children) {
            if (child.type === 'parameter_declaration') {
              const typeNode = child.childForFieldName('type');
              if (typeNode) {
                receiverType = code.slice(typeNode.startIndex, typeNode.endIndex).replace(/^\*/, '');
                break;
              }
            }
          }
        }
        const fqname = receiverType ? `${receiverType}.${name}` : (namespace ? `${namespace}.${name}` : name);
        symbols.push({
          kind: 'function',
          name,
          fqname,
          range: { start: node.startIndex, end: node.endIndex }
        });
      }
    }
    // Type declarations (type aliases, structs, interfaces)
    else if (node.type === 'type_declaration') {
      // Type declarations can have multiple type specs
      for (const child of node.children) {
        if (child.type === 'type_spec') {
          const nameNode = child.childForFieldName('name');
          const typeNode = child.childForFieldName('type');
          if (nameNode) {
            const name = code.slice(nameNode.startIndex, nameNode.endIndex);
            let kind = 'type';
            
            // Determine specific kind based on type
            if (typeNode) {
              if (typeNode.type === 'struct_type') {
                kind = 'class';
              } else if (typeNode.type === 'interface_type') {
                kind = 'interface';
              }
            }
            
            symbols.push({
              kind,
              name,
              fqname: namespace ? `${namespace}.${name}` : name,
              range: { start: child.startIndex, end: child.endIndex }
            });
          }
        }
      }
    }
    // Const declarations
    else if (node.type === 'const_declaration') {
      for (const child of node.children) {
        if (child.type === 'const_spec') {
          const nameNode = child.childForFieldName('name');
          if (nameNode) {
            const name = code.slice(nameNode.startIndex, nameNode.endIndex);
            symbols.push({
              kind: 'variable',
              name,
              fqname: namespace ? `${namespace}.${name}` : name,
              range: { start: child.startIndex, end: child.endIndex }
            });
          }
        }
      }
    }
    // Var declarations
    else if (node.type === 'var_declaration') {
      for (const child of node.children) {
        if (child.type === 'var_spec') {
          const nameNode = child.childForFieldName('name');
          if (nameNode) {
            const name = code.slice(nameNode.startIndex, nameNode.endIndex);
            symbols.push({
              kind: 'variable',
              name,
              fqname: namespace ? `${namespace}.${name}` : name,
              range: { start: child.startIndex, end: child.endIndex }
            });
          }
        }
      }
    }
    // Short variable declarations (x := value)
    else if (node.type === 'short_var_declaration') {
      const leftNode = node.childForFieldName('left');
      if (leftNode) {
        // Can have multiple variables on the left side
        for (const child of leftNode.children) {
          if (child.type === 'identifier') {
            const name = code.slice(child.startIndex, child.endIndex);
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
    // Import declarations
    else if (node.type === 'import_declaration') {
      // Import declaration has an import_spec_list child
      for (const child of node.children) {
        if (child.type === 'import_spec_list') {
          // Process each import spec in the list
          for (const spec of child.children) {
            if (spec.type === 'import_spec') {
              const pathNode = spec.childForFieldName('path');
              if (pathNode) {
                const source = code.slice(pathNode.startIndex, pathNode.endIndex).replace(/['"]/g, '');
                const nameNode = spec.childForFieldName('name');
                const names: string[] = [];
                
                if (nameNode) {
                  // Aliased import
                  names.push(code.slice(nameNode.startIndex, nameNode.endIndex));
                } else {
                  // Extract package name from path (last segment)
                  const parts = source.split('/');
                  names.push(parts[parts.length - 1]);
                }
                
                imports.push({
                  source,
                  names,
                  range: { start: spec.startIndex, end: spec.endIndex }
                });
              }
            }
          }
        } else if (child.type === 'import_spec') {
          // Single import without parentheses
          const pathNode = child.childForFieldName('path');
          if (pathNode) {
            const source = code.slice(pathNode.startIndex, pathNode.endIndex).replace(/['"]/g, '');
            const nameNode = child.childForFieldName('name');
            const names: string[] = [];
            
            if (nameNode) {
              // Aliased import
              names.push(code.slice(nameNode.startIndex, nameNode.endIndex));
            } else {
              // Extract package name from path (last segment)
              const parts = source.split('/');
              names.push(parts[parts.length - 1]);
            }
            
            imports.push({
              source,
              names,
              range: { start: child.startIndex, end: child.endIndex }
            });
          }
        }
      }
    }
    // Call expressions
    else if (node.type === 'call_expression') {
      const funcNode = node.childForFieldName('function');
      if (funcNode) {
        const callee = code.slice(funcNode.startIndex, funcNode.endIndex);
        calls.push({
          callee,
          range: { start: node.startIndex, end: node.endIndex }
        });
      }
    }
    // Package clause (for namespace)
    else if (node.type === 'package_clause') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const packageName = code.slice(nameNode.startIndex, nameNode.endIndex);
        // Update namespace for this file
        namespace = packageName;
      }
    }

    // Recurse to children
    for (const child of node.children) {
      this.extractGoSymbols(child, code, symbols, imports, calls, filePath, namespace);
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

