import Parser from 'tree-sitter';
import { BaseParser, ParsedSymbol, ImportDeclaration, CallSite } from './base-parser';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Python = require('tree-sitter-python');

/**
 * Parser for Python files
 */
export class PythonParser extends BaseParser {
  constructor() {
    super(Python, 'python');
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
          this.extractSymbols(bodyNode, code, symbols, imports, calls, filePath, fqname);
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
      this.extractSymbols(child, code, symbols, imports, calls, filePath, namespace);
    }
  }
}

