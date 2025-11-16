import Parser from 'tree-sitter';
import { BaseParser, ParsedSymbol, ImportDeclaration, CallSite } from './base-parser';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const CSharp = require('tree-sitter-c-sharp');

/**
 * Parser for C# files
 */
export class CSharpParser extends BaseParser {
  constructor() {
    try {
      console.log('[Radium C#] Loading tree-sitter-c-sharp language...');
      console.log('[Radium C#] CSharp module type:', typeof CSharp);
      console.log('[Radium C#] CSharp module keys:', Object.keys(CSharp || {}));
      
      super(CSharp, 'csharp');
      
      console.log('[Radium C#] Parser initialized successfully');
      console.log('[Radium C#] Parser language:', this.parser.getLanguage() ? 'loaded' : 'NOT loaded');
    } catch (error) {
      console.error('[Radium C#] Failed to initialize C# parser:', error);
      console.error('[Radium C#] Error details:', (error as Error).message);
      console.error('[Radium C#] Error stack:', (error as Error).stack);
      throw error;
    }
  }

  protected extractSymbols(
    node: Parser.SyntaxNode,
    code: string,
    symbols: ParsedSymbol[],
    imports: ImportDeclaration[],
    calls: CallSite[],
    filePath: string,
    namespace: string = ''
  ): void {
    // Debug logging for .xaml.cs files
    const isXamlCs = filePath.includes('.xaml.cs');
    
    // Method declarations
    if (node.type === 'method_declaration' || node.type === 'local_function_statement') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const name = code.slice(nameNode.startIndex, nameNode.endIndex);
        if (isXamlCs) {
          console.log(`[C# Parser] Found method: ${name} in namespace: ${namespace}, byte range: ${node.startIndex}-${node.endIndex}`);
        }
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
        if (isXamlCs) {
          console.log(`[C# Parser] Found class: ${name}, byte range: ${node.startIndex}-${node.endIndex}`);
        }
        symbols.push({
          kind: 'class',
          name,
          fqname,
          range: { start: node.startIndex, end: node.endIndex }
        });
        // Recurse into class body with new namespace
        const bodyNode = node.childForFieldName('body');
        if (bodyNode) {
          if (isXamlCs) {
            console.log(`[C# Parser] Recursing into class body for: ${name}, body has ${bodyNode.childCount} children`);
          }
          this.extractSymbols(bodyNode, code, symbols, imports, calls, filePath, fqname);
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
          this.extractSymbols(bodyNode, code, symbols, imports, calls, filePath, fqname);
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
          kind: 'struct',
          name,
          fqname,
          range: { start: node.startIndex, end: node.endIndex }
        });
        // Recurse into struct body with new namespace
        const bodyNode = node.childForFieldName('body');
        if (bodyNode) {
          this.extractSymbols(bodyNode, code, symbols, imports, calls, filePath, fqname);
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
          this.extractSymbols(bodyNode, code, symbols, imports, calls, filePath, fqname);
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
          this.extractSymbols(bodyNode, code, symbols, imports, calls, filePath, newNamespace);
        }
        return; // Don't recurse to children again
      }
    }

    // Recurse to children
    for (const child of node.children) {
      if (isXamlCs && node.type === 'declaration_list') {
        console.log(`[C# Parser] Processing child node type: ${child.type} in declaration_list`);
      }
      this.extractSymbols(child, code, symbols, imports, calls, filePath, namespace);
    }
  }
}

