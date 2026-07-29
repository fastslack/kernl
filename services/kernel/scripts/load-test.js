// k6 Load Test for Kernl API
// Usage: k6 run scripts/load-test.js
// With auth: k6 run -e AUTH_TOKEN=<token> scripts/load-test.js

import http from "k6/http";
import { check, sleep } from "k6";

const BASE = __ENV.BASE_URL || "http://localhost:3087";
const TOKEN = __ENV.AUTH_TOKEN || "";

const headers = TOKEN
  ? { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }
  : { "Content-Type": "application/json" };

export const options = {
  stages: [
    { duration: "10s", target: 10 },   // ramp up
    { duration: "30s", target: 50 },   // sustain
    { duration: "10s", target: 0 },    // ramp down
  ],
  thresholds: {
    http_req_duration: ["p(95)<500"],   // 95% under 500ms
    http_req_failed: ["rate<0.01"],     // <1% errors
  },
};

export default function () {
  // Health check (no auth)
  const health = http.get(`${BASE}/api/health`);
  check(health, { "health 200": (r) => r.status === 200 });

  // Dashboard KPIs
  const kpis = http.get(`${BASE}/api/dashboard/kpis`, { headers });
  check(kpis, { "kpis 200": (r) => r.status === 200 });

  // Task list
  const tasks = http.get(`${BASE}/api/dashboard/tasks`, { headers });
  check(tasks, { "tasks 200": (r) => r.status === 200 });

  // CRM
  const crm = http.get(`${BASE}/api/dashboard/crm`, { headers });
  check(crm, { "crm 200": (r) => r.status === 200 });

  // Metrics (no auth)
  const metrics = http.get(`${BASE}/api/metrics`);
  check(metrics, { "metrics 200": (r) => r.status === 200 });

  sleep(0.5);
}
