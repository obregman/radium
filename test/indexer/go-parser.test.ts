import * as assert from 'assert';
import { CodeParser } from '../../src/indexer/parser';

suite('Go Parser Test Suite', () => {
  let parser: CodeParser;

  setup(() => {
    parser = new CodeParser();
  });

  test('should detect Go structs', async () => {
    const code = `
package main

type Point struct {
    X int
    Y int
}

func (p Point) Distance() float64 {
    return math.Sqrt(float64(p.X*p.X + p.Y*p.Y))
}`;
    
    const result = await parser.parseFile('test.go', code);
    
    assert.ok(result, 'Should return parse result');
    
    const structSymbol = result!.symbols.find(s => s.name === 'Point');
    assert.ok(structSymbol, 'Should find Point struct');
    assert.strictEqual(structSymbol!.kind, 'struct', 'Struct should be detected as struct');
    
    const method = result!.symbols.find(s => s.name === 'Distance');
    assert.ok(method, 'Should find Distance method');
  });

  test('should detect multiple Go structs in same file', async () => {
    const code = `
package main

type Vector2 struct {
    X float32
    Y float32
}

type Vector3 struct {
    X float32
    Y float32
    Z float32
}

type Color struct {
    R byte
    G byte
    B byte
    A byte
}

func (v Vector3) Magnitude() float32 {
    return float32(math.Sqrt(float64(v.X*v.X + v.Y*v.Y + v.Z*v.Z)))
}`;
    
    const result = await parser.parseFile('test.go', code);
    
    assert.ok(result, 'Should return parse result');
    
    const structs = result!.symbols.filter(s => s.kind === 'struct');
    assert.strictEqual(structs.length, 3, 'Should find 3 structs');
    
    const vector2 = structs.find(s => s.name === 'Vector2');
    assert.ok(vector2, 'Should find Vector2 struct');
    
    const vector3 = structs.find(s => s.name === 'Vector3');
    assert.ok(vector3, 'Should find Vector3 struct');
    
    const color = structs.find(s => s.name === 'Color');
    assert.ok(color, 'Should find Color struct');
    
    // Verify Vector3 has a method
    const magnitude = result!.symbols.find(s => s.name === 'Magnitude');
    assert.ok(magnitude, 'Should find Magnitude method for Vector3 struct');
  });

  test('should distinguish Go structs from interfaces', async () => {
    const code = `
package main

type Reader interface {
    Read(p []byte) (n int, err error)
}

type FileReader struct {
    path string
}

func (f FileReader) Read(p []byte) (n int, err error) {
    // Implementation
    return 0, nil
}`;
    
    const result = await parser.parseFile('test.go', code);
    
    assert.ok(result, 'Should return parse result');
    
    const interfaceSymbol = result!.symbols.find(s => s.name === 'Reader');
    assert.ok(interfaceSymbol, 'Should find Reader interface');
    assert.strictEqual(interfaceSymbol!.kind, 'interface', 'Reader should be detected as interface');
    
    const structSymbol = result!.symbols.find(s => s.name === 'FileReader');
    assert.ok(structSymbol, 'Should find FileReader struct');
    assert.strictEqual(structSymbol!.kind, 'struct', 'FileReader should be detected as struct');
  });

  test('should detect Go structs with embedded fields', async () => {
    const code = `
package main

type Base struct {
    ID int
    Name string
}

type Extended struct {
    Base
    Extra string
}

func (e Extended) GetName() string {
    return e.Name
}`;
    
    const result = await parser.parseFile('test.go', code);
    
    assert.ok(result, 'Should return parse result');
    
    const baseStruct = result!.symbols.find(s => s.name === 'Base');
    assert.ok(baseStruct, 'Should find Base struct');
    assert.strictEqual(baseStruct!.kind, 'struct', 'Base should be detected as struct');
    
    const extendedStruct = result!.symbols.find(s => s.name === 'Extended');
    assert.ok(extendedStruct, 'Should find Extended struct with embedded field');
    assert.strictEqual(extendedStruct!.kind, 'struct', 'Extended should be detected as struct');
    
    const method = result!.symbols.find(s => s.name === 'GetName');
    assert.ok(method, 'Should find GetName method');
  });

  test('should detect Go structs with tags', async () => {
    const code = `
package main

type User struct {
    ID       int    \`json:"id" db:"user_id"\`
    Username string \`json:"username" db:"username"\`
    Email    string \`json:"email" db:"email"\`
}

func (u User) Validate() bool {
    return u.Email != ""
}`;
    
    const result = await parser.parseFile('test.go', code);
    
    assert.ok(result, 'Should return parse result');
    
    const structSymbol = result!.symbols.find(s => s.name === 'User');
    assert.ok(structSymbol, 'Should find User struct with tags');
    assert.strictEqual(structSymbol!.kind, 'struct', 'User should be detected as struct');
    
    const method = result!.symbols.find(s => s.name === 'Validate');
    assert.ok(method, 'Should find Validate method');
  });

  test('should detect Go type aliases', async () => {
    const code = `
package main

type UserID int
type Username string

type Config struct {
    Port int
    Host string
}`;
    
    const result = await parser.parseFile('test.go', code);
    
    assert.ok(result, 'Should return parse result');
    
    const userID = result!.symbols.find(s => s.name === 'UserID');
    assert.ok(userID, 'Should find UserID type alias');
    assert.strictEqual(userID!.kind, 'type', 'UserID should be detected as type');
    
    const username = result!.symbols.find(s => s.name === 'Username');
    assert.ok(username, 'Should find Username type alias');
    assert.strictEqual(username!.kind, 'type', 'Username should be detected as type');
    
    const config = result!.symbols.find(s => s.name === 'Config');
    assert.ok(config, 'Should find Config struct');
    assert.strictEqual(config!.kind, 'struct', 'Config should be detected as struct');
  });

  test('should detect Go interfaces', async () => {
    const code = `
package main

type Writer interface {
    Write(p []byte) (n int, err error)
}

type ReadWriter interface {
    Read(p []byte) (n int, err error)
    Write(p []byte) (n int, err error)
}

type Closer interface {
    Close() error
}`;
    
    const result = await parser.parseFile('test.go', code);
    
    assert.ok(result, 'Should return parse result');
    
    const interfaces = result!.symbols.filter(s => s.kind === 'interface');
    assert.ok(interfaces.length >= 3, `Should find at least 3 interfaces, found ${interfaces.length}`);
    
    const writer = interfaces.find(s => s.name === 'Writer');
    assert.ok(writer, 'Should find Writer interface');
    
    const readWriter = interfaces.find(s => s.name === 'ReadWriter');
    assert.ok(readWriter, 'Should find ReadWriter interface');
    
    const closer = interfaces.find(s => s.name === 'Closer');
    assert.ok(closer, 'Should find Closer interface');
  });

  test('should detect Go functions', async () => {
    const code = `
package main

func Add(a, b int) int {
    return a + b
}

func Multiply(a, b int) int {
    return a * b
}

func main() {
    result := Add(1, 2)
    println(result)
}`;
    
    const result = await parser.parseFile('test.go', code);
    
    assert.ok(result, 'Should return parse result');
    
    const functions = result!.symbols.filter(s => s.kind === 'function');
    assert.ok(functions.length >= 3, `Should find at least 3 functions, found ${functions.length}`);
    
    const add = functions.find(s => s.name === 'Add');
    assert.ok(add, 'Should find Add function');
    
    const multiply = functions.find(s => s.name === 'Multiply');
    assert.ok(multiply, 'Should find Multiply function');
    
    const main = functions.find(s => s.name === 'main');
    assert.ok(main, 'Should find main function');
  });

  test('should detect Go methods on structs', async () => {
    const code = `
package main

type Rectangle struct {
    Width  float64
    Height float64
}

func (r Rectangle) Area() float64 {
    return r.Width * r.Height
}

func (r *Rectangle) Scale(factor float64) {
    r.Width *= factor
    r.Height *= factor
}

func (r Rectangle) Perimeter() float64 {
    return 2 * (r.Width + r.Height)
}`;
    
    const result = await parser.parseFile('test.go', code);
    
    assert.ok(result, 'Should return parse result');
    
    const structSymbol = result!.symbols.find(s => s.name === 'Rectangle');
    assert.ok(structSymbol, 'Should find Rectangle struct');
    assert.strictEqual(structSymbol!.kind, 'struct', 'Rectangle should be detected as struct');
    
    const area = result!.symbols.find(s => s.name === 'Area');
    assert.ok(area, 'Should find Area method');
    
    const scale = result!.symbols.find(s => s.name === 'Scale');
    assert.ok(scale, 'Should find Scale method (pointer receiver)');
    
    const perimeter = result!.symbols.find(s => s.name === 'Perimeter');
    assert.ok(perimeter, 'Should find Perimeter method');
  });

  test('should detect Go constants', async () => {
    const code = `
package main

const Pi = 3.14159
const MaxRetries = 5

const (
    StatusOK = 200
    StatusNotFound = 404
    StatusError = 500
)`;
    
    const result = await parser.parseFile('test.go', code);
    
    assert.ok(result, 'Should return parse result');
    
    const constants = result!.symbols.filter(s => s.kind === 'constant');
    assert.ok(constants.length >= 3, `Should find at least 3 constants, found ${constants.length}`);
    
    const pi = constants.find(s => s.name === 'Pi');
    assert.ok(pi, 'Should find Pi constant');
    
    const maxRetries = constants.find(s => s.name === 'MaxRetries');
    assert.ok(maxRetries, 'Should find MaxRetries constant');
  });

  test('should detect nested Go structs', async () => {
    const code = `
package main

type Address struct {
    Street string
    City   string
    Zip    string
}

type Person struct {
    Name    string
    Age     int
    Address Address
}

func (p Person) GetFullAddress() string {
    return p.Address.Street + ", " + p.Address.City
}`;
    
    const result = await parser.parseFile('test.go', code);
    
    assert.ok(result, 'Should return parse result');
    
    const address = result!.symbols.find(s => s.name === 'Address');
    assert.ok(address, 'Should find Address struct');
    assert.strictEqual(address!.kind, 'struct', 'Address should be detected as struct');
    
    const person = result!.symbols.find(s => s.name === 'Person');
    assert.ok(person, 'Should find Person struct');
    assert.strictEqual(person!.kind, 'struct', 'Person should be detected as struct');
    
    const method = result!.symbols.find(s => s.name === 'GetFullAddress');
    assert.ok(method, 'Should find GetFullAddress method');
  });
});

