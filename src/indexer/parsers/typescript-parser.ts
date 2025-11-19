import Parser from 'tree-sitter';
import { BaseParser, ParsedSymbol, ImportDeclaration, CallSite } from './base-parser';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const TypeScript = require('tree-sitter-typescript').typescript;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const TSX = require('tree-sitter-typescript').tsx;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const JavaScript = require('tree-sitter-javascript');

/**
 * Parser for TypeScript, TSX, and JavaScript files
 */
export class TypeScriptParser extends BaseParser {
  constructor(variant: string = 'typescript') {
    let language;
    if (variant === 'tsx') {
      language = TSX;
    } else if (variant === 'javascript') {
      language = JavaScript;
    } else {
      language = TypeScript;
    }
    super(language, variant);
  }

  protected extractSymbols(
    node: Parser.SyntaxNode,
    code: string,
    symbols: ParsedSymbol[],
    imports: ImportDeclaration[],
    calls: CallSite[],
    filePath: string,
    namespace: string = '',
    insideFunction: boolean = false
  ): void {
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
      // Mark that we're now inside a function - don't capture variables inside
      insideFunction = true;
    } else if (node.type === 'arrow_function' || node.type === 'function' || node.type === 'function_expression') {
      // Arrow functions, anonymous functions, and function expressions
      // Mark that we're inside a function to skip variable declarations
      insideFunction = true;
    } else if (node.type === 'export_statement') {
      // Handle exported declarations (common in TSX/TS files)
      // The actual declaration is in the 'declaration' field
      const declarationNode = node.childForFieldName('declaration');
      if (declarationNode) {
        // Process the exported declaration (function, class, interface, etc.)
        this.extractSymbols(declarationNode, code, symbols, imports, calls, filePath, namespace, insideFunction);
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
        // Reset insideFunction to false when entering a class body
        const bodyNode = node.childForFieldName('body');
        if (bodyNode) {
          this.extractSymbols(bodyNode, code, symbols, imports, calls, filePath, fqname, false);
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
      // Only handle const, let, var declarations if NOT inside a function
      // This captures class-level variables, module-level variables, but not local function variables
      if (!insideFunction) {
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
    }

    // Recurse to children, passing along the insideFunction flag
    for (const child of node.children) {
      this.extractSymbols(child, code, symbols, imports, calls, filePath, namespace, insideFunction);
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
}

