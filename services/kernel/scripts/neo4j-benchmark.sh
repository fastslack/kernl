#!/bin/bash
# Neo4j Benchmark for Kernl
# Usage: bash neo4j-benchmark.sh [label]

LABEL="${1:-baseline}"
CYPHER="sg docker -c \"docker exec mtw-neo4j cypher-shell -u neo4j -p password\""
RESULTS="/tmp/neo4j-bench-${LABEL}.txt"

echo "═══════════════════════════════════════════════════" > "$RESULTS"
echo "  Neo4j Benchmark: $LABEL" >> "$RESULTS"
echo "  $(date)" >> "$RESULTS"
echo "═══════════════════════════════════════════════════" >> "$RESULTS"

# Resource usage
echo "" >> "$RESULTS"
echo "── Resource Usage ──" >> "$RESULTS"
sg docker -c "docker stats mtw-neo4j --no-stream --format 'CPU: {{.CPUPerc}} | MEM: {{.MemUsage}} ({{.MemPerc}}) | PIDs: {{.PIDs}}'" >> "$RESULTS" 2>&1

bench() {
    local name="$1"
    local query="$2"
    local start=$(date +%s%N)
    eval "$CYPHER '$query'" > /dev/null 2>&1
    local end=$(date +%s%N)
    local ms=$(( (end - start) / 1000000 ))
    echo "  $name: ${ms}ms" | tee -a "$RESULTS"
}

echo "" >> "$RESULTS"
echo "── Benchmark Queries ──" >> "$RESULTS"
echo "" | tee -a "$RESULTS"

# 1. Simple read
bench "1. Simple RETURN" "RETURN 1"

# 2. Node count
bench "2. Count all nodes" "MATCH (n) RETURN count(n)"

# 3. Count relationships
bench "3. Count all relationships" "MATCH ()-[r]->() RETURN count(r)"

# 4. Label scan
bench "4. Find all Person nodes" "MATCH (p:Person) RETURN count(p)"

# 5. Property lookup
bench "5. Property lookup (Person by name)" "MATCH (p:Person) WHERE p.name CONTAINS 'a' RETURN count(p)"

# 6. Relationship traversal 1 hop
bench "6. Traverse 1 hop" "MATCH (a)-[r]->(b) RETURN count(r) LIMIT 1000"

# 7. Relationship traversal 2 hops
bench "7. Traverse 2 hops" "MATCH (a)-[]->(b)-[]->(c) RETURN count(c) LIMIT 1000"

# 8. Relationship traversal 3 hops
bench "8. Traverse 3 hops" "MATCH (a)-[]->(b)-[]->(c)-[]->(d) RETURN count(d) LIMIT 100"

# 9. Shortest path
bench "9. Shortest path query" "MATCH (a:Person), (b:Person) WHERE a <> b WITH a, b LIMIT 1 MATCH p = shortestPath((a)-[*..5]-(b)) RETURN length(p)"

# 10. Aggregation
bench "10. Aggregation by label" "MATCH (n) RETURN labels(n)[0] AS label, count(n) ORDER BY count(n) DESC LIMIT 10"

# 11. Write: create node
bench "11. Write: create node" "CREATE (t:BenchTest {ts: datetime(), val: rand()}) RETURN t.ts"

# 12. Write: create + relationship
bench "12. Write: create + relationship" "CREATE (a:BenchTest {ts: datetime()})-[:BENCH_REL]->(b:BenchTest {ts: datetime()}) RETURN a.ts"

# 13. Pattern matching
bench "13. Pattern match (variable length)" "MATCH path = (n)-[*1..3]->(m) RETURN count(path) LIMIT 100"

# 14. Index-backed lookup (if indexes exist)
bench "14. Index lookup (Task by id)" "MATCH (t:Task {id: 'nonexistent'}) RETURN t"

# 15. UNWIND + batch operation
bench "15. UNWIND batch (100 items)" "UNWIND range(1,100) AS i CREATE (n:BenchBatch {i: i}) RETURN count(n)"

# Cleanup bench nodes
eval "$CYPHER 'MATCH (n:BenchTest) DETACH DELETE n'" > /dev/null 2>&1
eval "$CYPHER 'MATCH (n:BenchBatch) DETACH DELETE n'" > /dev/null 2>&1

echo "" | tee -a "$RESULTS"
echo "── DB Stats ──" >> "$RESULTS"
eval "$CYPHER 'CALL db.stats.retrieve(\"GRAPH COUNTS\") YIELD data RETURN data'" >> "$RESULTS" 2>&1

echo "" | tee -a "$RESULTS"
echo "Results saved to: $RESULTS"
cat "$RESULTS"
