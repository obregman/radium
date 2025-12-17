import Parser from 'tree-sitter';
import { BaseParser, ParsedSymbol, ImportDeclaration, CallSite } from './base-parser';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Go = require('tree-sitter-go');

/**
 * Parser for Go files
 */
export class GoParser extends BaseParser {
  constructor() {
    super(Go, 'go');
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
                kind = 'struct';
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
              kind: 'constant',
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
          const valueNode = child.childForFieldName('value');
          
          if (nameNode) {
            const name = code.slice(nameNode.startIndex, nameNode.endIndex);
            
            // Check if the value is a function literal
            const isFunctionValue = valueNode && valueNode.type === 'func_literal';
            
            symbols.push({
              kind: isFunctionValue ? 'function' : 'variable',
              name: isFunctionValue ? name + '()' : name,
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
      this.extractSymbols(child, code, symbols, imports, calls, filePath, namespace);
    }
  }
}

