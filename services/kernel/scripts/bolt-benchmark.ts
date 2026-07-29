// Neo4j Bolt Driver Benchmark — real-world performance
import neo4j from "neo4j-driver";

const driver = neo4j.driver(
  "bolt://localhost:17687",
  neo4j.auth.basic("neo4j", "password"),
  { maxConnectionPoolSize: 50, connectionTimeout: 60000 },
);

async function bench(name: string, query: string, params?: Record<string, unknown>): Promise<number> {
  const session = driver.session();
  const start = performance.now();
  try {
    await session.run(query, params);
  } finally {
    await session.close();
  }
  const ms = Math.round((performance.now() - start) * 100) / 100;
  console.log(`  ${name}: ${ms}ms`);
  return ms;
}

async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log("  Neo4j Bolt Driver Benchmark (real-world)");
  console.log("═══════════════════════════════════════════════\n");

  // Warmup
  const ws = driver.session();
  await ws.run("RETURN 1");
  await ws.close();

  const results: number[] = [];

  results.push(await bench("1.  Simple RETURN", "RETURN 1"));
  results.push(await bench("2.  Count all nodes", "MATCH (n) RETURN count(n)"));
  results.push(await bench("3.  Count relationships", "MATCH ()-[r]->() RETURN count(r)"));
  results.push(await bench("4.  Find Person nodes", "MATCH (p:Person) RETURN count(p)"));
  results.push(await bench("5.  Property lookup", "MATCH (p:Person) WHERE p.name CONTAINS 'a' RETURN count(p)"));
  results.push(await bench("6.  Traverse 1 hop", "MATCH (a)-[r]->(b) RETURN count(r) LIMIT 1000"));
  results.push(await bench("7.  Traverse 2 hops", "MATCH (a)-[]->(b)-[]->(c) RETURN count(c) LIMIT 1000"));
  results.push(await bench("8.  Traverse 3 hops", "MATCH (a)-[]->(b)-[]->(c)-[]->(d) RETURN count(d) LIMIT 100"));
  results.push(await bench("9.  Shortest path", "MATCH (a:Person), (b:Person) WHERE a <> b WITH a, b LIMIT 1 MATCH p = shortestPath((a)-[*..5]-(b)) RETURN length(p)"));
  results.push(await bench("10. Aggregation by label", "MATCH (n) RETURN labels(n)[0] AS label, count(n) ORDER BY count(n) DESC LIMIT 10"));
  results.push(await bench("11. Write node", "CREATE (t:BenchTest {ts: datetime(), val: rand()}) RETURN t.ts"));
  results.push(await bench("12. Write + relationship", "CREATE (a:BenchTest {ts: datetime()})-[:BENCH]->(b:BenchTest {ts: datetime()}) RETURN a.ts"));
  results.push(await bench("13. Pattern match", "MATCH path = (n)-[*1..3]->(m) RETURN count(path) LIMIT 100"));
  results.push(await bench("14. Index lookup", "MATCH (t:Task {id: 'nonexistent'}) RETURN t"));
  results.push(await bench("15. Batch 100", "UNWIND range(1,100) AS i CREATE (n:BenchBatch {i: i}) RETURN count(n)"));

  // Cleanup
  const cs = driver.session();
  await cs.run("MATCH (n:BenchTest) DETACH DELETE n");
  await cs.run("MATCH (n:BenchBatch) DETACH DELETE n");
  await cs.close();

  const avg = Math.round(results.reduce((a, b) => a + b, 0) / results.length * 100) / 100;
  const max = Math.max(...results);
  const min = Math.min(...results);

  console.log("\n── Summary ──");
  console.log(`  Average: ${avg}ms`);
  console.log(`  Min:     ${min}ms`);
  console.log(`  Max:     ${max}ms`);
  console.log(`  Total:   ${Math.round(results.reduce((a, b) => a + b, 0))}ms`);

  await driver.close();
}

main().catch(console.error);
