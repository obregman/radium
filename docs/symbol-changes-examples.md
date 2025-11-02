# Symbol Changes - Detection Examples

This document shows what the Symbol Changes visualization detects and how it displays different types of code changes.

## Detected Change Types

### 1. ✅ Adding a Function

**Code Change:**
```typescript
// Before: (function doesn't exist)

// After:
function calculateTotal(items: Item[]): number {
  return items.reduce((sum, item) => sum + item.price, 0);
}
```

**Visualization:**
- **Teal box** with label "calculateTotal"
- **Green pulsing** animation
- Details: "New"
- Type badge: "FUNCTION"

---

### 2. 🔧 Changing a Function

**Code Change:**
```typescript
// Before:
function processOrder(order: Order) {
  validateOrder(order);
  return order;
}

// After:
function processOrder(order: Order) {
  validateOrder(order);
  calculateShipping(order);
  applyDiscounts(order);
  return order;
}
```

**Visualization:**
- **Teal box** with label "processOrder"
- **Yellow pulsing** animation
- Details: "+2 -0" (2 lines added, 0 removed)
- Type badge: "FUNCTION"

---

### 3. 📦 Adding Variables

**Code Change:**
```typescript
// Before: (variable doesn't exist)

// After:
const MAX_RETRIES = 3;
let currentAttempt = 0;
```

**Visualization:**
- **Gold box** with label "MAX_RETRIES"
  - **Green pulsing** animation
  - Details: "= 3"
  - Type badge: "CONSTANT"

- **Yellow box** with label "currentAttempt"
  - **Green pulsing** animation
  - Details: "= 0"
  - Type badge: "VARIABLE"

---

### 4. 🔄 Changing Variable Values

**Code Change:**
```typescript
// Before:
const API_TIMEOUT = 5000;

// After:
const API_TIMEOUT = 10000;
```

**Visualization:**
- **Gold box** with label "API_TIMEOUT"
- **Orange pulsing** animation
- Details: "5000 → 10000"
- Type badge: "CONSTANT"

---

### 5. 📋 Creating an Interface

**Code Change:**
```typescript
// Before: (interface doesn't exist)

// After:
interface UserProfile {
  id: string;
  name: string;
  email: string;
}
```

**Visualization:**
- **Light blue dashed box** with label "UserProfile"
- **Green pulsing** animation
- Details: "New"
- Type badge: "INTERFACE"

---

### 6. 🔗 Adding a Call to Another Function

**Code Change:**
```typescript
// Before:
function processPayment(payment: Payment) {
  return savePayment(payment);
}

// After:
function processPayment(payment: Payment) {
  validatePayment(payment);  // New call
  return savePayment(payment);
}

function validatePayment(payment: Payment) {
  // validation logic
}
```

**Visualization:**
- **Two teal boxes**: "processPayment" and "validatePayment"
- **Animated curved arrow** from "processPayment" to "validatePayment"
- Both functions show as modified (yellow pulse)
- Arrow has dashed animation showing the call direction

---

## Complex Example: Multiple Changes

**Code Change:**
```typescript
// Before:
function checkout(cart: Cart) {
  return cart.total;
}

// After:
const TAX_RATE = 0.08;

interface CheckoutResult {
  subtotal: number;
  tax: number;
  total: number;
}

function calculateTax(amount: number): number {
  return amount * TAX_RATE;
}

function checkout(cart: Cart): CheckoutResult {
  const subtotal = cart.total;
  const tax = calculateTax(subtotal);
  return {
    subtotal,
    tax,
    total: subtotal + tax
  };
}
```

**Visualization Shows:**

1. **Gold box** "TAX_RATE" (constant, green pulse, "= 0.08")
2. **Light blue dashed box** "CheckoutResult" (interface, green pulse, "New")
3. **Teal box** "calculateTax" (function, green pulse, "New")
4. **Teal box** "checkout" (function, yellow pulse, "+5 -1")
5. **Animated arrow** from "checkout" to "calculateTax" (showing the call)

All organized horizontally in the same file group, with clear visual hierarchy.

---

## Python Examples

### Adding a Variable
```python
# Before: (variable doesn't exist)

# After:
max_connections = 100
```

**Visualization:**
- **Yellow box** "max_connections"
- **Green pulse**
- Details: "= 100"
- Type: "VARIABLE"

### Changing a Variable Value
```python
# Before:
timeout = 30

# After:
timeout = 60
```

**Visualization:**
- **Yellow box** "timeout"
- **Orange pulse**
- Details: "30 → 60"
- Type: "VARIABLE"

---

## Visual Legend

The visualization includes a legend showing:

- 🟦 **Function** - Teal rounded box
- 🟦 **Class** - Blue rectangular box
- 🟪 **Method** - Purple rounded box
- 🔷 **Interface/Type** - Light blue dashed box
- 🟨 **Variable** - Yellow rounded box
- 🟧 **Constant** - Gold rounded box

Plus color-coded pulse animations:
- 🟢 Green = Added
- 🟡 Yellow = Modified
- 🟠 Orange = Value Changed
- 🔴 Red = Deleted

