/** Reproduce the facade UPDATE against a copy of the live DB. */
import { Database } from "bun:sqlite";

const db = new Database("/tmp/facade-debug.db");

const existing = db
  .prepare("SELECT id, slug, source_extension_id, flow_id FROM agents WHERE builtin_handler = 'check:overdue-tasks'")
  .get();
console.log("BEFORE:", existing);

const id = (existing as { id: string }).id;

// Test 1: bare keys with @ placeholders
console.log("\n--- Test 1: bare keys, @ placeholders ---");
const r1 = db.prepare("UPDATE agents SET slug = @slug WHERE id = @id").run({ slug: "v1", id });
console.log("Result:", r1);
console.log("After:", db.prepare("SELECT slug FROM agents WHERE id = ?").get(id));

// Test 2: @-prefixed keys
console.log("\n--- Test 2: @-prefixed keys ---");
const r2 = db.prepare("UPDATE agents SET slug = @slug WHERE id = @id").run({ "@slug": "v2", "@id": id });
console.log("Result:", r2);
console.log("After:", db.prepare("SELECT slug FROM agents WHERE id = ?").get(id));

// Test 3: $-prefixed keys + $ placeholders
console.log("\n--- Test 3: $-prefixed keys + $ placeholders ---");
const r3 = db.prepare("UPDATE agents SET slug = $slug WHERE id = $id").run({ $slug: "v3", $id: id });
console.log("Result:", r3);
console.log("After:", db.prepare("SELECT slug FROM agents WHERE id = ?").get(id));

// Test 4: positional
console.log("\n--- Test 4: positional ? ---");
const r4 = db.prepare("UPDATE agents SET slug = ? WHERE id = ?").run("v4", id);
console.log("Result:", r4);
console.log("After:", db.prepare("SELECT slug FROM agents WHERE id = ?").get(id));
