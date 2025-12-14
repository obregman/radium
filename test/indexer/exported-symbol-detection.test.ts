import * as assert from 'assert';
import { CodeParser } from '../../src/indexer/parser';

/**
 * Tests for exported symbol detection - verifying that imports and exports
 * are correctly parsed for cross-file reference tracking.
 * 
 * NOTE: The files-map-panel.ts calculates "exported symbols" by counting
 * cross-file edges where dstNode.path !== srcNode.path. This test suite
 * validates that the parser correctly extracts the imports that would
 * enable this edge creation.
 */
suite('Exported Symbol Detection Test Suite', () => {
  let parser: CodeParser;

  setup(() => {
    parser = new CodeParser();
  });

  suite('TypeScript Import Detection', () => {
    test('should parse named imports correctly', async () => {
      const code = `import { Component, OnInit } from '@angular/core';
import { UserService, User } from './services/user.service';
import type { Config } from './types';

export class AppComponent implements OnInit {
  constructor(private userService: UserService) {}
}
`;
      const result = await parser.parseFile('test.ts', code);
      
      assert.ok(result, 'Should return parse result');
      assert.ok(result!.imports.length >= 2, 'Should detect at least 2 imports');

      const angularImport = result!.imports.find(i => i.source === '@angular/core');
      assert.ok(angularImport, 'Should find @angular/core import');
      assert.ok(angularImport!.names.includes('Component'), 'Should include Component in names');
      assert.ok(angularImport!.names.includes('OnInit'), 'Should include OnInit in names');

      const userServiceImport = result!.imports.find(i => i.source === './services/user.service');
      assert.ok(userServiceImport, 'Should find user service import');
      assert.ok(userServiceImport!.names.includes('UserService'), 'Should include UserService in names');
      assert.ok(userServiceImport!.names.includes('User'), 'Should include User in names');
    });

    test('should parse default imports correctly', async () => {
      const code = `import React from 'react';
import DefaultExport from './myModule';

export function Component() {
  return <div>Hello</div>;
}
`;
      const result = await parser.parseFile('test.tsx', code);
      
      assert.ok(result, 'Should return parse result');
      assert.ok(result!.imports.length >= 2, 'Should detect at least 2 imports');

      const reactImport = result!.imports.find(i => i.source === 'react');
      assert.ok(reactImport, 'Should find react import');
      assert.ok(reactImport!.names.includes('React'), 'Should include React in names');

      const moduleImport = result!.imports.find(i => i.source === './myModule');
      assert.ok(moduleImport, 'Should find myModule import');
      assert.ok(moduleImport!.names.includes('DefaultExport'), 'Should include DefaultExport in names');
    });

    test('should parse namespace imports correctly', async () => {
      const code = `import * as path from 'path';
import * as utils from './utils';

export function getPath() {
  return path.join('a', 'b');
}
`;
      const result = await parser.parseFile('test.ts', code);
      
      assert.ok(result, 'Should return parse result');
      assert.ok(result!.imports.length >= 2, 'Should detect at least 2 imports');

      const pathImport = result!.imports.find(i => i.source === 'path');
      assert.ok(pathImport, 'Should find path import');
      // Namespace imports capture the alias
      assert.ok(pathImport!.names.length > 0, 'Should have names for namespace import');

      const utilsImport = result!.imports.find(i => i.source === './utils');
      assert.ok(utilsImport, 'Should find utils import');
    });

    test('should parse mixed imports correctly', async () => {
      const code = `import React, { useState, useEffect } from 'react';
import DefaultClass, { namedExport } from './myModule';

export function Component() {
  const [count, setCount] = useState(0);
  return <div>{count}</div>;
}
`;
      const result = await parser.parseFile('test.tsx', code);
      
      assert.ok(result, 'Should return parse result');
      assert.ok(result!.imports.length >= 2, 'Should detect at least 2 imports');

      const reactImport = result!.imports.find(i => i.source === 'react');
      assert.ok(reactImport, 'Should find react import');
      // Should capture both default and named imports
      assert.ok(reactImport!.names.includes('React'), 'Should include React (default) in names');
      assert.ok(reactImport!.names.includes('useState'), 'Should include useState in names');
      assert.ok(reactImport!.names.includes('useEffect'), 'Should include useEffect in names');
    });

    test('should detect call sites that reference imported symbols', async () => {
      const code = `import { DataService } from './data-service';

export function useData() {
  const service = new DataService();
  return service.fetchData();
}
`;
      const result = await parser.parseFile('test.ts', code);
      
      assert.ok(result, 'Should return parse result');
      
      // Check imports
      const dataServiceImport = result!.imports.find(i => i.source === './data-service');
      assert.ok(dataServiceImport, 'Should find data-service import');
      assert.ok(dataServiceImport!.names.includes('DataService'), 'Should include DataService in names');
      
      // Check call sites - should detect new DataService()
      const constructorCall = result!.calls.find(c => c.callee === 'DataService');
      assert.ok(constructorCall, 'Should detect new DataService() call');
      
      // Check call sites - should detect service.fetchData()
      const methodCall = result!.calls.find(c => c.callee === 'service.fetchData');
      assert.ok(methodCall, 'Should detect service.fetchData() call');
    });

    test('should detect static method calls on imported classes', async () => {
      const code = `import { WebContentExtractor } from './extractor';

export class Consumer {
  private extractor: WebContentExtractor;
  
  constructor() {
    this.extractor = WebContentExtractor.getInstance();
  }
}
`;
      const result = await parser.parseFile('test.ts', code);
      
      assert.ok(result, 'Should return parse result');
      
      // Check imports
      const extractorImport = result!.imports.find(i => i.source === './extractor');
      assert.ok(extractorImport, 'Should find extractor import');
      
      // Check call sites - should detect WebContentExtractor.getInstance()
      const staticCall = result!.calls.find(c => c.callee === 'WebContentExtractor.getInstance');
      assert.ok(staticCall, 'Should detect WebContentExtractor.getInstance() static call');
    });

    test('should parse re-exports correctly', async () => {
      const code = `export { formatDate, parseDate } from './utils';
export { default as MainComponent } from './main';
export * from './helpers';
`;
      const result = await parser.parseFile('index.ts', code);
      
      assert.ok(result, 'Should return parse result');
      
      // Note: re-exports are typically handled as exports, not imports
      // The exact behavior depends on how the parser handles export_statement
      console.log('Imports found:', result!.imports);
      console.log('Symbols found:', result!.symbols);
    });
  });

  suite('C# Import Detection', () => {
    test('should parse using directives correctly', async () => {
      const code = `using System;
using System.Collections.Generic;
using MyApp.Services;
using MyApp.Models;

namespace MyApp.Controllers
{
    public class TestController
    {
    }
}
`;
      const result = await parser.parseFile('test.cs', code);
      
      assert.ok(result, 'Should return parse result');
      assert.ok(result!.imports.length >= 4, 'Should detect at least 4 using directives');

      const systemImport = result!.imports.find(i => i.source === 'System');
      assert.ok(systemImport, 'Should find System using directive');

      const collectionsImport = result!.imports.find(i => i.source === 'System.Collections.Generic');
      assert.ok(collectionsImport, 'Should find System.Collections.Generic using directive');

      const servicesImport = result!.imports.find(i => i.source === 'MyApp.Services');
      assert.ok(servicesImport, 'Should find MyApp.Services using directive');

      const modelsImport = result!.imports.find(i => i.source === 'MyApp.Models');
      assert.ok(modelsImport, 'Should find MyApp.Models using directive');
    });

    test('should detect constructor calls in C#', async () => {
      const code = `using System;
using MyApp.Services;

namespace MyApp.Controllers
{
    public class UserController
    {
        private readonly UserService _userService;
        
        public UserController()
        {
            _userService = new UserService();
        }
        
        public string GetUser(int id)
        {
            return _userService.GetUserName(id);
        }
    }
}
`;
      const result = await parser.parseFile('test.cs', code);
      
      assert.ok(result, 'Should return parse result');
      
      // Check that new UserService() is detected as a call
      const constructorCall = result!.calls.find(c => c.callee === 'UserService');
      assert.ok(constructorCall, 'Should detect new UserService() call');
      
      // Check method call
      const methodCall = result!.calls.find(c => c.callee.includes('GetUserName'));
      assert.ok(methodCall, 'Should detect GetUserName() call');
    });

    test('should detect static method calls in C#', async () => {
      const code = `using System;

namespace MyApp
{
    public class Program
    {
        public static void Main()
        {
            Console.WriteLine("Hello");
            var result = Math.Max(1, 2);
            var guid = Guid.NewGuid();
        }
    }
}
`;
      const result = await parser.parseFile('test.cs', code);
      
      assert.ok(result, 'Should return parse result');
      
      // Check static calls
      const writeLineCall = result!.calls.find(c => c.callee === 'Console.WriteLine');
      assert.ok(writeLineCall, 'Should detect Console.WriteLine() call');
      
      const maxCall = result!.calls.find(c => c.callee === 'Math.Max');
      assert.ok(maxCall, 'Should detect Math.Max() call');
      
      const newGuidCall = result!.calls.find(c => c.callee === 'Guid.NewGuid');
      assert.ok(newGuidCall, 'Should detect Guid.NewGuid() call');
    });

    test('should parse static using directives in C#', async () => {
      const code = `using System;
using static System.Console;
using static System.Math;

namespace MyApp
{
    public class Program
    {
        public static void Main()
        {
            WriteLine("Hello");
        }
    }
}
`;
      const result = await parser.parseFile('test.cs', code);
      
      assert.ok(result, 'Should return parse result');
      assert.ok(result!.imports.length >= 1, 'Should detect at least 1 using directive');
      
      // Static usings may be parsed differently
      console.log('Imports found:', result!.imports.map(i => i.source));
    });
  });

  suite('Symbol Export Detection', () => {
    test('should detect exported classes in TypeScript', async () => {
      const code = `export class MyService {
  doSomething() {
    console.log('doing something');
  }
}

class InternalClass {
  helper() {}
}

export class AnotherService {}
`;
      const result = await parser.parseFile('test.ts', code);
      
      assert.ok(result, 'Should return parse result');
      
      // Should find both exported classes
      const myService = result!.symbols.find(s => s.name === 'MyService' && s.kind === 'class');
      assert.ok(myService, 'Should find MyService class');
      
      const anotherService = result!.symbols.find(s => s.name === 'AnotherService' && s.kind === 'class');
      assert.ok(anotherService, 'Should find AnotherService class');
      
      // Should also find internal class (we track all symbols, not just exports)
      const internalClass = result!.symbols.find(s => s.name === 'InternalClass' && s.kind === 'class');
      assert.ok(internalClass, 'Should find InternalClass class');
    });

    test('should detect exported functions in TypeScript', async () => {
      const code = `export function publicFunction() {
  return 42;
}

function privateFunction() {
  return 'private';
}

export const arrowFunction = () => {
  return 'arrow';
};
`;
      const result = await parser.parseFile('test.ts', code);
      
      assert.ok(result, 'Should return parse result');
      
      const publicFunc = result!.symbols.find(s => s.name === 'publicFunction' && s.kind === 'function');
      assert.ok(publicFunc, 'Should find publicFunction');
      
      const privateFunc = result!.symbols.find(s => s.name === 'privateFunction' && s.kind === 'function');
      assert.ok(privateFunc, 'Should find privateFunction');
      
      const arrowFunc = result!.symbols.find(s => s.name === 'arrowFunction');
      assert.ok(arrowFunc, 'Should find arrowFunction');
    });

    test('should detect exported interfaces and types in TypeScript', async () => {
      const code = `export interface User {
  id: string;
  name: string;
}

export type UserId = string;

interface InternalInterface {
  data: any;
}
`;
      const result = await parser.parseFile('test.ts', code);
      
      assert.ok(result, 'Should return parse result');
      
      const userInterface = result!.symbols.find(s => s.name === 'User' && s.kind === 'interface');
      assert.ok(userInterface, 'Should find User interface');
      
      const userIdType = result!.symbols.find(s => s.name === 'UserId' && s.kind === 'type');
      assert.ok(userIdType, 'Should find UserId type');
      
      const internalInterface = result!.symbols.find(s => s.name === 'InternalInterface' && s.kind === 'interface');
      assert.ok(internalInterface, 'Should find InternalInterface');
    });

    test('should detect public classes in C#', async () => {
      const code = `namespace MyApp
{
    public class PublicService
    {
        public void DoWork() {}
    }
    
    internal class InternalService
    {
        void Helper() {}
    }
    
    public interface IRepository
    {
        void Save();
    }
}
`;
      const result = await parser.parseFile('test.cs', code);
      
      assert.ok(result, 'Should return parse result');
      
      const publicService = result!.symbols.find(s => s.name === 'PublicService' && s.kind === 'class');
      assert.ok(publicService, 'Should find PublicService class');
      
      const internalService = result!.symbols.find(s => s.name === 'InternalService' && s.kind === 'class');
      assert.ok(internalService, 'Should find InternalService class');
      
      const repository = result!.symbols.find(s => s.name === 'IRepository' && s.kind === 'interface');
      assert.ok(repository, 'Should find IRepository interface');
    });
  });

  suite('Const Arrow Function Exports', () => {
    test('should detect exported const arrow functions', async () => {
      const code = `export const getMCPResourceEnrichmentService = () => MCPResourceEnrichmentService.getInstance();

class MCPResourceEnrichmentService {
  private static instance: MCPResourceEnrichmentService;
  static getInstance() {
    if (!this.instance) this.instance = new MCPResourceEnrichmentService();
    return this.instance;
  }
}
`;
      const result = await parser.parseFile('mcp-service.ts', code);
      
      assert.ok(result, 'Should return parse result');
      
      // Should find the exported const arrow function as a variable
      const getMCPService = result!.symbols.find(s => s.name === 'getMCPResourceEnrichmentService');
      assert.ok(getMCPService, 'Should find getMCPResourceEnrichmentService');
      assert.strictEqual(getMCPService!.kind, 'variable', 'Should be detected as variable');
    });

    test('should detect imports and calls to const arrow function exports', async () => {
      const code = `import { getMCPResourceEnrichmentService } from './mcp-service';

export class Consumer {
  init() {
    const service = getMCPResourceEnrichmentService();
  }
}
`;
      const result = await parser.parseFile('consumer.ts', code);
      
      assert.ok(result, 'Should return parse result');
      
      // Check import is detected
      const mcpImport = result!.imports.find(i => i.source === './mcp-service');
      assert.ok(mcpImport, 'Should find mcp-service import');
      assert.ok(mcpImport!.names.includes('getMCPResourceEnrichmentService'), 
        'Import names should include getMCPResourceEnrichmentService');
      
      // Check call is detected
      const serviceCall = result!.calls.find(c => c.callee === 'getMCPResourceEnrichmentService');
      assert.ok(serviceCall, 'Should detect call to getMCPResourceEnrichmentService()');
    });

    test('should detect multiple const arrow function exports', async () => {
      const code = `export const createService = () => new MyService();
export const getLogger = () => Logger.getInstance();
export const formatDate = (date: Date) => date.toISOString();
export const MAX_RETRIES = 3;

class MyService {}
class Logger {
  static getInstance() { return new Logger(); }
}
`;
      const result = await parser.parseFile('utils.ts', code);
      
      assert.ok(result, 'Should return parse result');
      
      const createService = result!.symbols.find(s => s.name === 'createService');
      assert.ok(createService, 'Should find createService');
      
      const getLogger = result!.symbols.find(s => s.name === 'getLogger');
      assert.ok(getLogger, 'Should find getLogger');
      
      const formatDate = result!.symbols.find(s => s.name === 'formatDate');
      assert.ok(formatDate, 'Should find formatDate');
      
      const maxRetries = result!.symbols.find(s => s.name === 'MAX_RETRIES');
      assert.ok(maxRetries, 'Should find MAX_RETRIES');
    });
  });

  suite('Cross-file Reference Scenarios', () => {
    test('should correctly parse file that imports and uses external classes', async () => {
      const code = `import { UserService } from './services/user.service';
import { ProductService } from './services/product.service';
import { OrderService } from './services/order.service';

export class OrderController {
  private userService: UserService;
  private productService: ProductService;
  private orderService: OrderService;
  
  constructor() {
    this.userService = new UserService();
    this.productService = new ProductService();
    this.orderService = new OrderService();
  }
  
  async createOrder(userId: string, productId: string) {
    const user = await this.userService.getUser(userId);
    const product = await this.productService.getProduct(productId);
    return this.orderService.create({ user, product });
  }
}
`;
      const result = await parser.parseFile('order.controller.ts', code);
      
      assert.ok(result, 'Should return parse result');
      
      // Check imports
      assert.strictEqual(result!.imports.length, 3, 'Should find 3 imports');
      
      const userImport = result!.imports.find(i => i.source === './services/user.service');
      assert.ok(userImport, 'Should find user.service import');
      assert.ok(userImport!.names.includes('UserService'), 'Should include UserService');
      
      const productImport = result!.imports.find(i => i.source === './services/product.service');
      assert.ok(productImport, 'Should find product.service import');
      
      const orderImport = result!.imports.find(i => i.source === './services/order.service');
      assert.ok(orderImport, 'Should find order.service import');
      
      // Check constructor calls (new ClassName())
      const userServiceCall = result!.calls.find(c => c.callee === 'UserService');
      assert.ok(userServiceCall, 'Should detect new UserService() call');
      
      const productServiceCall = result!.calls.find(c => c.callee === 'ProductService');
      assert.ok(productServiceCall, 'Should detect new ProductService() call');
      
      const orderServiceCall = result!.calls.find(c => c.callee === 'OrderService');
      assert.ok(orderServiceCall, 'Should detect new OrderService() call');
      
      // Log all detected calls for debugging
      console.log('All calls:', result!.calls.map(c => c.callee));
    });

    test('should correctly parse C# file with multiple dependencies', async () => {
      const code = `using System;
using System.Threading.Tasks;
using MyApp.Services;
using MyApp.Repositories;

namespace MyApp.Controllers
{
    public class ApiController
    {
        private readonly IUserRepository _userRepo;
        private readonly IProductRepository _productRepo;
        
        public ApiController(IUserRepository userRepo, IProductRepository productRepo)
        {
            _userRepo = userRepo;
            _productRepo = productRepo;
        }
        
        public async Task<User> GetUser(int id)
        {
            var user = await _userRepo.FindById(id);
            return user;
        }
        
        public async Task<Product> GetProduct(int id)
        {
            return await _productRepo.FindById(id);
        }
    }
}
`;
      const result = await parser.parseFile('ApiController.cs', code);
      
      assert.ok(result, 'Should return parse result');
      
      // Check using directives
      assert.ok(result!.imports.length >= 4, 'Should find at least 4 using directives');
      
      const servicesImport = result!.imports.find(i => i.source === 'MyApp.Services');
      assert.ok(servicesImport, 'Should find MyApp.Services using');
      
      const reposImport = result!.imports.find(i => i.source === 'MyApp.Repositories');
      assert.ok(reposImport, 'Should find MyApp.Repositories using');
      
      // Check class and methods
      const controller = result!.symbols.find(s => s.name === 'ApiController' && s.kind === 'class');
      assert.ok(controller, 'Should find ApiController class');
      
      const getUser = result!.symbols.find(s => s.name === 'GetUser' && s.kind === 'function');
      assert.ok(getUser, 'Should find GetUser method');
      
      const getProduct = result!.symbols.find(s => s.name === 'GetProduct' && s.kind === 'function');
      assert.ok(getProduct, 'Should find GetProduct method');
      
      // Log all detected calls for debugging
      console.log('All calls:', result!.calls.map(c => c.callee));
    });
  });
});
