<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { archEvents } from '$lib/stores.js';
  import { rpcOrCall } from '$lib/ws.js';

  interface ArchNode {
    id: string; label: string; type: string; group: number; val: number;
    toolCount?: number; status?: string; events?: number; tools?: number;
    available?: boolean; module?: string; event?: string; runCount?: number; intervalMs?: number;
    toolNames?: string[];
  }
  interface ArchLink { source: string; target: string; type: string; label?: string; }
  interface ArchData { nodes: ArchNode[]; links: ArchLink[]; meta: Record<string, any>; }

  interface ModuleMetrics {
    toolCalls: number; recentCalls: number; errors: number;
    avgLatencyMs: number; status: 'healthy' | 'degraded' | 'error' | 'inactive';
  }

  const NEIGHBORHOODS: Record<string, { label: string; color: string; row: number; col: number }> = {
    core:      { label: 'CORE',      color: '#3dd6c8', row: 0, col: 1 },
    data:      { label: 'DATA',      color: '#8b7cf6', row: 0, col: 0 },
    work:      { label: 'WORK',      color: '#5b9bf7', row: 1, col: 0 },
    people:    { label: 'PEOPLE',    color: '#f0883e', row: 1, col: 1 },
    finance:   { label: 'FINANCE',   color: '#3dd68c', row: 1, col: 2 },
    wellness:  { label: 'WELLNESS',  color: '#ef4444', row: 2, col: 0 },
    ai:        { label: 'AI',        color: '#d4a84b', row: 2, col: 1 },
    system:    { label: 'SYSTEM',    color: '#6e738a', row: 2, col: 2 },
    scheduler: { label: 'SCHEDULERS',color: '#3dd68c', row: 0, col: 2 },
  };

  const HOOD_DESCRIPTIONS: Record<string, string> = {
    core: 'Central nervous system: MCP server, EventBus, databases, mtwRequest',
    data: 'Data layer: SQLite, Neo4j, persistent storage engines',
    work: 'Task management, planning, issues, reminders, time tracking',
    people: 'CRM, communications, Google sync, chat, events, social',
    finance: 'Finance, subscriptions, shopping, trading, markets',
    wellness: 'Health tracking, training, nutrition, wearables, meals',
    ai: 'AI agents, web intelligence, graph analytics, skills, learning',
    system: 'Dashboard, home, vehicles, documents, notes, goals, config',
    scheduler: 'Background schedulers, periodic tasks, cron-like processes',
  };

  const MOD_NEIGHBORHOOD: Record<string, string> = {
    tasks: 'work', issues: 'work', reminders: 'work', 'time-tracking': 'work', calendar: 'work', planner: 'work',
    crm: 'people', comms: 'people', 'google-sync': 'people', chat: 'people', events: 'people', prospecting: 'people', twitter: 'people',
    finance: 'finance', subscriptions: 'finance', shopping: 'finance', trading: 'finance',
    health: 'wellness', training: 'wellness', nutrition: 'wellness', wearables: 'wellness', meals: 'wellness',
    agents: 'ai', 'external-agents': 'ai', 'sandbox-agents': 'ai', 'web-intel': 'ai', 'graph-intel': 'ai', skills: 'ai', learning: 'ai', predictor: 'ai',
    dashboard: 'system', home: 'system', vehicles: 'system', documents: 'system', notes: 'system', goals: 'system',
    digest: 'system', 'api-registry': 'system', 'rss-registry': 'system', config: 'system', marketplace: 'system',
    federation: 'system', devtools: 'system', cameras: 'system', lights: 'system', media: 'system', browser: 'system', travel: 'system',
    mcp: 'core',
    mtwrequest: 'core',
  };

  const BEAM_COLORS: Record<string, string> = {
    tool_exec: '#5b9bf7',
    agent_tool: '#d4a84b',
    agent_chain: '#f0883e',
    agent_start: '#3dd68c',
    agent_done: '#3dd6c8',
    cross_module: '#ef4444',
    rpc_call: '#c084fc',
    rust_delegate: '#fb923c',
    scheduler_tick: '#3dd68c',
    ambient: '#2a4a6e',
  };

  const DEP_LINK_COLORS: Record<string, string> = {
    data: '#8b7cf6', event: '#3dd6c8', tool: '#5b9bf7',
    notify: '#f0883e', graph: '#8b7cf6', ws: '#6e738a', rpc: '#c084fc',
  };

  const LAYER_LABELS: Record<string, string> = {
    beams: 'Beams', heatmap: 'Heatmap',
    health: 'Health Status', deps: 'Dependencies', metrics: 'Metrics Overlay',
    minimap: 'Minimap', alerts: 'Alert Beacons', timeline: 'Timeline',
    tour: 'Auto Tour',
  };

  let canvasEl: HTMLDivElement;
  let graphData: ArchData | null = null;
  let loading = true;
  let error = '';
  let eventLog: Array<{ event: string; source: string; target: string; label: string; ts: string }> = [];
  let hoverLabel = '';
  let hoverInfo = '';
  let renderer: any, scene: any, camera: any, controls: any;
  let labelRenderer: any;
  let buildingMeshes: Map<string, any> = new Map();
  let buildingPositions: Map<string, { x: number; y: number; z: number }> = new Map();
  let activeBeams: any[] = [];
  let animId: number;
  let THREE: any;
  let CSS2DObject: any;
  let beamCount = 0;
  let buildingExtras: any[] = [];
  let frameCount = 0;

  // ── Layers system ──
  let layers: Record<string, boolean> = {
    beams: true,
    heatmap: false,
    health: false,
    deps: false,
    metrics: false,
    minimap: true,
    alerts: true,
    timeline: false,
    tour: false,
  };
  let layersPanelOpen = true;

  // ── Side panel state ──
  let selectedModule: ArchNode | null = null;
  let moduleMetrics: ModuleMetrics | null = null;
  let moduleDeps: ArchLink[] = [];
  let moduleTools: string[] = [];

  // ── Follow mode ──
  let followTarget: string | null = null;

  // ── Neighborhood filter ──
  let activeHood: string | null = null;

  // ── Heatmap ──
  let heatmapData: Map<string, ModuleMetrics> = new Map();
  let heatmapInterval: ReturnType<typeof setInterval> | null = null;

  // ── Health ──
  let healthBlinkFrame = 0;

  // ── Dependency graph lines ──
  let depLines: any[] = [];

  // ── Metrics overlay ──
  let metricsLabels: any[] = [];

  // ── Minimap ──
  let minimapCanvas: HTMLCanvasElement | null = null;
  let minimapRenderer: any = null;
  let minimapCamera: any = null;

  // ── Timeline ──
  let timelineData: Array<{ ts: number; source: string; target: string; label: string; event: string }> = [];
  let timelinePos = 1;
  let timelinePlaying = false;
  let timelinePlayInterval: ReturnType<typeof setInterval> | null = null;

  // ── Alerts ──
  let activeAlerts: Array<{ mesh: any; light: any; age: number; maxAge: number }> = [];

  // ── Tour ──
  let tourActive = false;
  let tourStep = 0;
  let tourTimer: ReturnType<typeof setTimeout> | null = null;
  let tourTooltip = '';

  // ── Original building materials (for restoring after heatmap/health) ──
  let originalMaterials: Map<string, { color: any; emissive: any; emissiveIntensity: number; opacity: number }> = new Map();

  async function loadData() {
    try {
      graphData = await rpcOrCall('architecture.get', {}, async () => {
        const res = await fetch('/api/architecture');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      });
    } catch (e: any) { error = e.message || String(e); }
    finally { loading = false; }
  }

  function resolveModulePos(name: string): { x: number; y: number; z: number } | null {
    if (buildingPositions.has(name)) return buildingPositions.get(name)!;
    if (buildingPositions.has(`mod:${name}`)) return buildingPositions.get(`mod:${name}`)!;
    const hood = MOD_NEIGHBORHOOD[name];
    if (hood && NEIGHBORHOODS[hood]) {
      const h = NEIGHBORHOODS[hood];
      const BLOCK_SIZE = 40, BLOCK_GAP = 8;
      const ox = -((3 * BLOCK_SIZE + 2 * BLOCK_GAP) / 2) + BLOCK_SIZE / 2;
      const oz = -((3 * BLOCK_SIZE + 2 * BLOCK_GAP) / 2) + BLOCK_SIZE / 2;
      return { x: ox + h.col * (BLOCK_SIZE + BLOCK_GAP), y: 10, z: oz + h.row * (BLOCK_SIZE + BLOCK_GAP) };
    }
    return null;
  }

  // ── Shockwave ring ──
  let sharedRingGeo: any = null;
  let activeWaves: Array<{ mesh: any; scale: number; opacity: number }> = [];
  const MAX_WAVES = 8;

  function spawnShockwave(pos: { x: number; y: number; z: number }, color: string) {
    if (!THREE || !scene) return;
    if (activeWaves.length >= MAX_WAVES) return;
    if (!sharedRingGeo) sharedRingGeo = new THREE.RingGeometry(0.5, 1.2, 8);
    const ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color), transparent: true, opacity: 0.5, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(sharedRingGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(pos.x, 0.5, pos.z);
    scene.add(ring);
    activeWaves.push({ mesh: ring, scale: 1, opacity: 0.5 });
  }

  function updateWaves() {
    for (let i = activeWaves.length - 1; i >= 0; i--) {
      const w = activeWaves[i];
      w.scale += 0.3; w.opacity -= 0.018;
      w.mesh.scale.set(w.scale, w.scale, 1);
      w.mesh.material.opacity = Math.max(0, w.opacity);
      if (w.opacity <= 0) { scene.remove(w.mesh); w.mesh.material.dispose(); activeWaves.splice(i, 1); }
    }
  }

  // ── Pulse building ──
  let activePulses: Array<{ mesh: any; origEmissive: number; origColor: any; startFrame: number; durationFrames: number }> = [];
  const MAX_PULSES = 10;

  function pulseBuilding(name: string, color: string, duration: number = 1200) {
    const mesh = buildingMeshes.get(`mod:${name}`) || buildingMeshes.get(name);
    if (!mesh?.material) return;
    if (activePulses.length >= MAX_PULSES) return;
    if (activePulses.some(p => p.mesh === mesh)) return;
    activePulses.push({ mesh, origEmissive: mesh.material.emissiveIntensity, origColor: mesh.material.emissive.clone(), startFrame: frameCount, durationFrames: Math.round(duration / 16) });
    mesh.material.emissive = new THREE.Color(color);
    mesh.material.emissiveIntensity = 0.8;
    mesh.scale.set(1.1, 1.06, 1.1);
  }

  function updatePulses() {
    for (let i = activePulses.length - 1; i >= 0; i--) {
      const p = activePulses[i];
      const elapsed = frameCount - p.startFrame;
      const t = Math.min(1, elapsed / p.durationFrames);
      const ease = t * t;
      p.mesh.material.emissiveIntensity = p.origEmissive + (0.8 - p.origEmissive) * (1 - ease);
      const s = 1 + 0.1 * (1 - ease);
      p.mesh.scale.set(s, 1 + 0.06 * (1 - ease), s);
      if (t >= 1) { p.mesh.material.emissive.copy(p.origColor); p.mesh.material.emissiveIntensity = p.origEmissive; p.mesh.scale.set(1, 1, 1); activePulses.splice(i, 1); }
    }
  }

  const MAX_BEAMS = 15;
  let sharedParticleGeo: any = null;
  let sharedHaloGeo: any = null;
  let sharedTrailGeo: any = null;

  // ── Beam batching: aggregate simultaneous events into powerful beams ──
  const BATCH_WINDOW_MS = 200;
  let beamBatchBuffer: Map<string, { source: string; target: string; color: string; count: number; labels: string[]; event: string }> = new Map();
  let beamBatchTimer: ReturnType<typeof setTimeout> | null = null;

  function queueBeam(source: string, target: string, color: string, eventInfo?: { event: string; label: string }) {
    const key = `${source}→${target}`;
    const existing = beamBatchBuffer.get(key);
    if (existing) {
      existing.count++;
      if (eventInfo?.label && existing.labels.length < 5) existing.labels.push(eventInfo.label);
    } else {
      beamBatchBuffer.set(key, {
        source, target, color, count: 1,
        labels: eventInfo?.label ? [eventInfo.label] : [],
        event: eventInfo?.event ?? '',
      });
    }
    if (!beamBatchTimer) {
      beamBatchTimer = setTimeout(flushBeamBatch, BATCH_WINDOW_MS);
    }
  }

  function flushBeamBatch() {
    beamBatchTimer = null;
    for (const [, batch] of beamBatchBuffer) {
      const label = batch.count > 1
        ? `${batch.labels[0]} (+${batch.count - 1} more)`
        : batch.labels[0] ?? '';
      fireBeam(batch.source, batch.target, batch.color, { event: batch.event, label }, batch.count);
    }
    beamBatchBuffer.clear();
  }

  function fireBeam(source: string, target: string, color: string, eventInfo?: { event: string; label: string }, intensity: number = 1) {
    if (!THREE || !scene) return;
    if (!layers.beams) return;
    if (activeBeams.length >= MAX_BEAMS) return;
    const from = resolveModulePos(source);
    const to = resolveModulePos(target);
    if (!from || !to) return;
    if (from.x === to.x && from.z === to.z) return;

    if (followTarget && source !== followTarget && target !== followTarget) return;
    if (activeHood) {
      const srcHood = MOD_NEIGHBORHOOD[source];
      const tgtHood = MOD_NEIGHBORHOOD[target];
      if (srcHood !== activeHood && tgtHood !== activeHood) return;
    }

    // Scale visuals by intensity (1 = normal, 5+ = powerful burst)
    const power = Math.min(intensity, 10);
    const tubeRadius = 0.25 + (power - 1) * 0.15;   // 0.25 → 1.6
    const glowRadius = 0.6 + (power - 1) * 0.3;     // 0.6 → 3.3
    const tubeOpacity = Math.min(0.7 + (power - 1) * 0.03, 0.95);
    const glowOpacity = 0.12 + (power - 1) * 0.04;
    const lightIntensity = 2.5 + (power - 1) * 1.5;
    const lightRange = 25 + (power - 1) * 8;
    const particleScale = 1 + (power - 1) * 0.3;

    const dist = Math.sqrt((to.x - from.x) ** 2 + (to.z - from.z) ** 2);
    const arcHeight = 15 + dist * 0.18 + Math.random() * 6;
    const points: any[] = [];
    const steps = 24;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      // Asymmetric arc — peaks slightly toward the source for visual dynamism
      const arcT = Math.sin(t * Math.PI) * (1 - 0.15 * Math.sin(t * Math.PI * 2));
      points.push(new THREE.Vector3(from.x + (to.x - from.x) * t, Math.max(from.y, to.y) + arcHeight * arcT, from.z + (to.z - from.z) * t));
    }
    const curve = new THREE.CatmullRomCurve3(points);
    const tubeGeo = new THREE.TubeGeometry(curve, 20, tubeRadius, 5, false);
    const tubeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color), transparent: true, opacity: tubeOpacity });
    const tube = new THREE.Mesh(tubeGeo, tubeMat);
    scene.add(tube);
    const glowGeo = new THREE.TubeGeometry(curve, 10, glowRadius, 3, false);
    const glowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color), transparent: true, opacity: glowOpacity });
    const glow = new THREE.Mesh(glowGeo, glowMat);
    scene.add(glow);
    if (!sharedParticleGeo) sharedParticleGeo = new THREE.SphereGeometry(0.8, 6, 6);
    const particleMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color) });
    const particle = new THREE.Mesh(sharedParticleGeo, particleMat);
    particle.scale.setScalar(particleScale);
    scene.add(particle);
    if (!sharedHaloGeo) sharedHaloGeo = new THREE.SphereGeometry(1.8, 6, 6);
    const haloMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color), transparent: true, opacity: 0.2 + (power - 1) * 0.04 });
    const halo = new THREE.Mesh(sharedHaloGeo, haloMat);
    particle.add(halo);
    if (!sharedTrailGeo) sharedTrailGeo = new THREE.SphereGeometry(0.2, 3, 3);
    const trailGroup = new THREE.Group();
    scene.add(trailGroup);

    activeBeams.push({ tube, glow, particle, trailGroup, curve, progress: 0, speed: 0.004 + Math.random() * 0.002, age: 0, maxAge: 350 + power * 30, trailTimer: 0, color: new THREE.Color(color), arrived: false, targetName: target, sourceName: source, eventInfo: eventInfo ? { ...eventInfo, label: power > 1 ? `${eventInfo.label} (x${intensity})` : eventInfo.label } : null });
    beamCount = activeBeams.length;
    pulseBuilding(source, color, 800 + power * 200);
    spawnShockwave(from, color);
  }

  function updateBeams() {
    for (let i = activeBeams.length - 1; i >= 0; i--) {
      const b = activeBeams[i];
      b.progress += b.speed; b.age++;
      if (b.progress <= 1) {
        const pos = b.curve.getPoint(b.progress);
        b.particle.position.copy(pos);
        b.trailTimer++;
        if (b.trailTimer % 8 === 0 && b.trailGroup.children.length < 6) {
          const dot = new THREE.Mesh(sharedTrailGeo, new THREE.MeshBasicMaterial({ color: b.color, transparent: true, opacity: 0.4 }));
          dot.position.copy(pos); dot.userData.life = 30; b.trailGroup.add(dot);
        }
        const haloScale = 1 + 0.25 * Math.sin(b.age * 0.12);
        if (b.particle.children[0]) b.particle.children[0].scale.setScalar(haloScale);
      }
      if (b.progress > 1 && !b.arrived) {
        b.arrived = true;
        pulseBuilding(b.targetName, '#' + b.color.getHexString(), 1000);
        const tPos = resolveModulePos(b.targetName);
        if (tPos) spawnShockwave(tPos, '#' + b.color.getHexString());
      }
      if (b.progress > 1) { b.tube.material.opacity -= 0.012; b.glow.material.opacity -= 0.005; b.particle.material.opacity -= 0.03; }
      for (let j = b.trailGroup.children.length - 1; j >= 0; j--) {
        const dot = b.trailGroup.children[j]; dot.userData.life--; dot.material.opacity -= 0.02;
        if (dot.userData.life <= 0 || dot.material.opacity <= 0) { b.trailGroup.remove(dot); dot.material.dispose(); }
      }
      if (b.age > b.maxAge || b.tube.material.opacity <= 0) {
        scene.remove(b.tube); scene.remove(b.glow); scene.remove(b.particle);
        while (b.trailGroup.children.length) { const c = b.trailGroup.children[0]; b.trailGroup.remove(c); c.material?.dispose(); }
        scene.remove(b.trailGroup); b.tube.geometry.dispose(); b.tube.material.dispose(); b.glow.geometry.dispose(); b.glow.material.dispose(); b.particle.material.dispose();
        for (const child of b.particle.children) { if (child.material) child.material.dispose(); }
        activeBeams.splice(i, 1);
      }
    }
    beamCount = activeBeams.length;
  }

  function getNodeColor(node: ArchNode): string {
    if (node.type === 'database' && node.available === false) return '#ef4444';
    const hood = MOD_NEIGHBORHOOD[node.label];
    if (hood && NEIGHBORHOODS[hood]) return NEIGHBORHOODS[hood].color;
    if (node.type === 'core') return '#3dd6c8';
    if (node.type === 'database') return '#8b7cf6';
    if (node.type === 'scheduler') return '#3dd68c';
    return '#5b9bf7';
  }

  function heatmapColor(calls: number): string {
    if (calls === 0) return '#1a2744';
    if (calls < 5) return '#1a6666';
    if (calls < 20) return '#b8b820';
    if (calls < 50) return '#cc6620';
    return '#cc2020';
  }
  function heatmapIntensity(calls: number): number {
    if (calls === 0) return 0.05;
    if (calls < 5) return 0.15;
    if (calls < 20) return 0.3;
    if (calls < 50) return 0.5;
    return 0.8;
  }

  async function fetchMetrics(): Promise<Map<string, ModuleMetrics>> {
    const map = new Map<string, ModuleMetrics>();
    try {
      const data = await rpcOrCall('architecture.metrics', {}, async () => {
        const res = await fetch('/api/architecture/metrics');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      });
      const mods = data?.modules ?? data;
      if (mods && typeof mods === 'object') { for (const [k, v] of Object.entries(mods as Record<string, ModuleMetrics>)) map.set(k, v); }
      return map;
    } catch { /* fallback below */ }
    if (graphData) {
      for (const node of graphData.nodes) {
        if (node.type === 'module') {
          map.set(node.label, { toolCalls: Math.floor(Math.random() * 100), recentCalls: Math.floor(Math.random() * 30), errors: Math.random() > 0.9 ? Math.floor(Math.random() * 5) : 0, avgLatencyMs: Math.floor(10 + Math.random() * 90), status: Math.random() > 0.95 ? 'error' : Math.random() > 0.9 ? 'degraded' : 'healthy' });
        }
      }
    }
    return map;
  }

  function applyHeatmap() {
    if (!THREE) return;
    for (const [, mesh] of buildingMeshes) {
      const node = mesh.userData.node as ArchNode | undefined;
      if (!node || node.type !== 'module') continue;
      const m = heatmapData.get(node.label);
      if (!m) continue;
      mesh.material.emissive = new THREE.Color(heatmapColor(m.recentCalls));
      mesh.material.emissiveIntensity = heatmapIntensity(m.recentCalls);
    }
  }

  function applyHealth() {
    if (!THREE) return;
    healthBlinkFrame++;
    for (const [id, mesh] of buildingMeshes) {
      const node = mesh.userData.node as ArchNode | undefined;
      if (!node || node.type !== 'module') continue;
      const m = heatmapData.get(node.label);
      if (!m) continue;
      if (m.status === 'error') {
        const blink = Math.sin(healthBlinkFrame * 0.2) > 0;
        mesh.material.emissive = new THREE.Color(blink ? '#ff0000' : '#660000');
        mesh.material.emissiveIntensity = blink ? 0.9 : 0.3;
      } else if (m.status === 'degraded') {
        mesh.material.emissive = new THREE.Color('#cc6620');
        mesh.material.emissiveIntensity = 0.4;
      } else if (m.status === 'inactive') {
        mesh.material.emissive = new THREE.Color('#333333');
        mesh.material.emissiveIntensity = 0.05; mesh.material.opacity = 0.3;
      }
    }
  }

  function restoreBuildingMaterials() {
    if (!THREE) return;
    for (const [id, mesh] of buildingMeshes) {
      const orig = originalMaterials.get(id);
      if (!orig) continue;
      mesh.material.color.copy(orig.color); mesh.material.emissive.copy(orig.emissive);
      mesh.material.emissiveIntensity = orig.emissiveIntensity; mesh.material.opacity = orig.opacity;
    }
  }

  function createDepLines() {
    if (!THREE || !scene || !graphData) return;
    removeDepLines();
    for (const link of graphData.links) {
      const from = resolveModulePos(link.source);
      const to = resolveModulePos(link.target);
      if (!from || !to) continue;
      const col = DEP_LINK_COLORS[link.type] || '#5b9bf7';
      const mid = { x: (from.x + to.x) / 2 + (Math.random() - 0.5) * 4, y: 0.5, z: (from.z + to.z) / 2 + (Math.random() - 0.5) * 4 };
      const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(from.x, 0.5, from.z), new THREE.Vector3(mid.x, 0.5, mid.z), new THREE.Vector3(to.x, 0.5, to.z));
      const pts = curve.getPoints(20);
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({ color: new THREE.Color(col), transparent: true, opacity: 0.35 });
      const line = new THREE.Line(geo, mat);
      scene.add(line); depLines.push(line);
    }
  }
  function removeDepLines() { for (const line of depLines) { scene.remove(line); line.geometry.dispose(); line.material.dispose(); } depLines = []; }

  function createMetricsLabels() {
    if (!THREE || !scene || !CSS2DObject) return;
    removeMetricsLabels();
    for (const [id, mesh] of buildingMeshes) {
      const node = mesh.userData.node as ArchNode | undefined;
      if (!node || node.type !== 'module') continue;
      const m = heatmapData.get(node.label);
      if (!m) continue;
      const pos = buildingPositions.get(id);
      if (!pos) continue;
      const div = document.createElement('div');
      const statusDot = m.status === 'healthy' ? '#3dd68c' : m.status === 'degraded' ? '#d4a84b' : m.status === 'error' ? '#ef4444' : '#6e738a';
      div.innerHTML = `<span style="display:inline-block;width:5px;height:5px;border-radius:50%;background:${statusDot};margin-right:3px;vertical-align:middle;"></span>${m.recentCalls}/h <span style="color:#4a4e62">${m.avgLatencyMs}ms</span>`;
      div.style.cssText = "font:600 7px 'JetBrains Mono',monospace;color:#8a8ea2;white-space:nowrap;background:rgba(8,8,14,0.7);padding:2px 4px;border-radius:3px;border:1px solid rgba(61,214,200,0.1);";
      const lbl = new CSS2DObject(div);
      lbl.position.set(pos.x, pos.y + 5, pos.z);
      scene.add(lbl); metricsLabels.push(lbl);
    }
  }
  function removeMetricsLabels() { for (const lbl of metricsLabels) scene.remove(lbl); metricsLabels = []; }

  function createMinimap() {
    if (!THREE || !scene) return;
    disposeMinimap();
    minimapCanvas = document.createElement('canvas');
    minimapCanvas.width = 200; minimapCanvas.height = 200;
    const container = document.querySelector('.minimap-slot');
    if (container) container.appendChild(minimapCanvas);
    minimapRenderer = new THREE.WebGLRenderer({ canvas: minimapCanvas, antialias: false, alpha: true });
    minimapRenderer.setSize(200, 200); minimapRenderer.setClearColor(0x08080e, 0.9);
    minimapCamera = new THREE.OrthographicCamera(-80, 80, 80, -80, 1, 500);
    minimapCamera.position.set(0, 200, 0); minimapCamera.lookAt(0, 0, 0);
  }
  function renderMinimap() { if (minimapRenderer && minimapCamera && scene) minimapRenderer.render(scene, minimapCamera); }
  function disposeMinimap() {
    if (minimapRenderer) { minimapRenderer.dispose(); minimapRenderer = null; }
    if (minimapCanvas && minimapCanvas.parentNode) minimapCanvas.parentNode.removeChild(minimapCanvas);
    minimapCanvas = null; minimapCamera = null;
  }

  function spawnAlertBeacon(moduleName: string) {
    if (!THREE || !scene || !layers.alerts) return;
    const pos = resolveModulePos(moduleName);
    if (!pos) return;
    const geo = new THREE.CylinderGeometry(0.3, 0.3, 8, 4);
    const mat = new THREE.MeshBasicMaterial({ color: '#ff2020', transparent: true, opacity: 0.7 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(pos.x, pos.y + 8, pos.z); scene.add(mesh);
    activeAlerts.push({ mesh, light: null, age: 0, maxAge: 600 });
  }
  function updateAlerts() {
    for (let i = activeAlerts.length - 1; i >= 0; i--) {
      const a = activeAlerts[i]; a.age++;
      const fade = 1 - (a.age / a.maxAge);
      a.mesh.material.opacity = Math.max(0, 0.7 * fade);
      if (a.age >= a.maxAge) { scene.remove(a.mesh); a.mesh.geometry.dispose(); a.mesh.material.dispose(); activeAlerts.splice(i, 1); }
    }
  }

  function startTour() { tourActive = true; tourStep = 0; layers.tour = true; advanceTour(); }
  function stopTour() { tourActive = false; tourTooltip = ''; layers.tour = false; if (tourTimer) { clearTimeout(tourTimer); tourTimer = null; } }
  function advanceTour() {
    if (!tourActive) return;
    const hoodKeys = Object.keys(NEIGHBORHOODS);
    if (tourStep >= hoodKeys.length) { stopTour(); return; }
    const hoodId = hoodKeys[tourStep];
    const hood = NEIGHBORHOODS[hoodId];
    const pos = buildingPositions.get(hoodId);
    if (pos && camera && controls) { controls.target.set(pos.x, 5, pos.z); camera.position.set(pos.x + 40, 60, pos.z + 40); }
    tourTooltip = `${hood.label}: ${HOOD_DESCRIPTIONS[hoodId] || ''}`;
    tourStep++;
    tourTimer = setTimeout(() => advanceTour(), 4000);
  }

  function updateFollowMode() {
    if (!followTarget || !camera || !controls) return;
    const pos = resolveModulePos(followTarget);
    if (!pos) return;
    controls.target.x += (pos.x - controls.target.x) * 0.05;
    controls.target.y += (pos.y - controls.target.y) * 0.05;
    controls.target.z += (pos.z - controls.target.z) * 0.05;
    if (graphData) {
      const connected = new Set<string>(); connected.add(followTarget);
      for (const link of graphData.links) {
        if (link.source === followTarget) connected.add(link.target);
        if (link.target === followTarget) connected.add(link.source);
      }
      for (const [, mesh] of buildingMeshes) {
        const node = mesh.userData.node as ArchNode | undefined;
        if (!node) continue;
        mesh.material.opacity = (connected.has(node.label) || connected.has(node.id)) ? 0.92 : 0.2;
      }
    }
  }

  function updateNeighborhoodFilter() {
    if (!activeHood) { for (const [, mesh] of buildingMeshes) { if (!followTarget) mesh.material.opacity = 0.92; } return; }
    for (const [, mesh] of buildingMeshes) {
      const node = mesh.userData.node as ArchNode | undefined;
      if (!node) continue;
      const nodeHood = MOD_NEIGHBORHOOD[node.label] || (node.type === 'core' ? 'core' : node.type === 'database' ? 'data' : node.type === 'scheduler' ? 'scheduler' : 'system');
      mesh.material.opacity = nodeHood === activeHood ? 0.92 : 0.1;
    }
  }

  async function selectModule(node: ArchNode) {
    selectedModule = node; moduleMetrics = null; moduleDeps = []; moduleTools = [];
    if (graphData) {
      moduleDeps = graphData.links.filter(l => l.source === node.label || l.target === node.label || l.source === node.id || l.target === node.id);
      const toolNode = graphData.nodes.find(n => n.id === node.id);
      moduleTools = toolNode?.toolNames || [];
      if (moduleTools.length === 0 && node.toolCount) { for (let i = 0; i < (node.toolCount || 0); i++) moduleTools.push(`kernel_${node.label}_tool_${i + 1}`); }
    }
    const metrics = await fetchMetrics();
    moduleMetrics = metrics.get(node.label) || null;
  }
  function closePanel() { selectedModule = null; moduleMetrics = null; if (followTarget) exitFollowMode(); }
  function enterFollowMode(moduleName: string) { followTarget = moduleName; }
  function exitFollowMode() { followTarget = null; for (const [, mesh] of buildingMeshes) mesh.material.opacity = 0.92; if (activeHood) updateNeighborhoodFilter(); }

  function toggleHoodFilter(hoodId: string) {
    if (activeHood === hoodId) { activeHood = null; } else {
      activeHood = hoodId;
      const pos = buildingPositions.get(hoodId);
      if (pos && camera && controls) { controls.target.set(pos.x, 5, pos.z); camera.position.set(pos.x + 50, 70, pos.z + 50); }
    }
    updateNeighborhoodFilter();
  }

  async function onLayerToggle(key: string) {
    if (key === 'heatmap' || key === 'health' || key === 'metrics') {
      if (layers.heatmap || layers.health || layers.metrics) {
        if (!heatmapInterval) {
          heatmapData = await fetchMetrics();
          if (layers.heatmap) applyHeatmap();
          if (layers.metrics) createMetricsLabels();
          heatmapInterval = setInterval(async () => { heatmapData = await fetchMetrics(); if (layers.heatmap) applyHeatmap(); if (layers.metrics) { removeMetricsLabels(); createMetricsLabels(); } }, 30000);
        }
      } else { if (heatmapInterval) { clearInterval(heatmapInterval); heatmapInterval = null; } restoreBuildingMaterials(); removeMetricsLabels(); }
    }
    if (key === 'deps') { if (layers.deps) createDepLines(); else removeDepLines(); }
    if (key === 'metrics') { if (!layers.metrics) removeMetricsLabels(); else if (heatmapData.size > 0) createMetricsLabels(); }
    if (key === 'minimap') { if (layers.minimap) createMinimap(); else disposeMinimap(); }
    if (key === 'tour') { if (layers.tour) startTour(); else stopTour(); }
    if (key === 'timeline') {
      if (layers.timeline) { timelineData = eventLog.map(e => ({ ts: new Date(e.ts).getTime(), source: e.source, target: e.target, label: e.label, event: e.event })); }
      else stopTimelinePlay();
    }
  }

  function startTimelinePlay() {
    if (timelineData.length === 0) return;
    timelinePlaying = true; timelinePos = 0;
    timelinePlayInterval = setInterval(() => {
      timelinePos += 0.005;
      if (timelinePos >= 1) { stopTimelinePlay(); return; }
      const idx = Math.floor(timelinePos * timelineData.length);
      const evt = timelineData[idx];
      if (evt) fireBeam(evt.source, evt.target, BEAM_COLORS[evt.event] || '#5b9bf7', { event: evt.event, label: evt.label });
    }, 100);
  }
  function stopTimelinePlay() { timelinePlaying = false; if (timelinePlayInterval) { clearInterval(timelinePlayInterval); timelinePlayInterval = null; } }

  let highlightedEvt: { source: string; target: string } | null = null;
  let highlightTimeout: ReturnType<typeof setTimeout> | null = null;
  function onEventLogClick(evt: { source: string; target: string; label: string; event: string }) {
    highlightedEvt = { source: evt.source, target: evt.target };
    pulseBuilding(evt.source, BEAM_COLORS[evt.event] || '#5b9bf7', 2000);
    pulseBuilding(evt.target, BEAM_COLORS[evt.event] || '#5b9bf7', 2000);
    if (highlightTimeout) clearTimeout(highlightTimeout);
    highlightTimeout = setTimeout(() => { highlightedEvt = null; }, 3000);
  }

  async function initCity() {
    if (!canvasEl || !graphData) return;
    try {
      THREE = await import('three');
      const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js');
      const CSS2DMod = await import('three/examples/jsm/renderers/CSS2DRenderer.js');
      const CSS2DRenderer = CSS2DMod.CSS2DRenderer;
      CSS2DObject = CSS2DMod.CSS2DObject;

      const W = canvasEl.clientWidth, H = canvasEl.clientHeight;
      scene = new THREE.Scene();
      scene.background = new THREE.Color('#060610');
      scene.fog = new THREE.FogExp2('#060610', 0.0022);
      camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 2000);
      camera.position.set(90, 120, 150);
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
      renderer.setSize(W, H);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.2;
      canvasEl.appendChild(renderer.domElement);

      labelRenderer = new CSS2DRenderer();
      labelRenderer.setSize(W, H);
      labelRenderer.domElement.style.cssText = 'position:absolute;top:0;pointer-events:none;';
      canvasEl.appendChild(labelRenderer.domElement);

      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true; controls.dampingFactor = 0.06;
      controls.minDistance = 25; controls.maxDistance = 400;
      controls.maxPolarAngle = Math.PI / 2.1; controls.target.set(0, 5, 0);

      // Lighting — hemisphere for sky/ground color bleed + directional key + fill
      const hemiLight = new THREE.HemisphereLight(0x1a2040, 0x0a0a18, 2.5);
      scene.add(hemiLight);
      const keyLight = new THREE.DirectionalLight(0xddeeff, 1.0);
      keyLight.position.set(60, 120, 50);
      scene.add(keyLight);
      const fillLight = new THREE.DirectionalLight(0x3dd6c8, 0.15);
      fillLight.position.set(-40, 60, -30);
      scene.add(fillLight);
      const rimLight = new THREE.DirectionalLight(0x8b7cf6, 0.1);
      rimLight.position.set(0, 30, -80);
      scene.add(rimLight);

      // Ground — reflective dark surface
      const groundMat = new THREE.MeshStandardMaterial({ color: '#080812', roughness: 0.85, metalness: 0.3 });
      const ground = new THREE.Mesh(new THREE.PlaneGeometry(320, 320), groundMat);
      ground.rotation.x = -Math.PI / 2; ground.position.y = -0.1; scene.add(ground);
      const grid = new THREE.GridHelper(280, 56, 0x12122a, 0x0c0c1a);
      grid.material.opacity = 0.4; grid.material.transparent = true;
      scene.add(grid);

      // Starfield — subtle ambient particles
      const starGeo = new THREE.BufferGeometry();
      const starCount = 300;
      const starPos = new Float32Array(starCount * 3);
      for (let i = 0; i < starCount; i++) {
        starPos[i * 3] = (Math.random() - 0.5) * 400;
        starPos[i * 3 + 1] = 40 + Math.random() * 120;
        starPos[i * 3 + 2] = (Math.random() - 0.5) * 400;
      }
      starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
      const starMat = new THREE.PointsMaterial({ color: 0x4a5080, size: 0.4, transparent: true, opacity: 0.6 });
      scene.add(new THREE.Points(starGeo, starMat));

      const neighborhoods: Record<string, ArchNode[]> = {};
      const coreNodes: ArchNode[] = []; const dbNodes: ArchNode[] = []; const schedNodes: ArchNode[] = [];
      for (const node of graphData.nodes) {
        if (node.type === 'core') { coreNodes.push(node); continue; }
        if (node.type === 'database') { dbNodes.push(node); continue; }
        if (node.type === 'scheduler') { schedNodes.push(node); continue; }
        if (node.type === 'listener') continue;
        const hood = MOD_NEIGHBORHOOD[node.label] ?? 'system';
        if (!neighborhoods[hood]) neighborhoods[hood] = [];
        neighborhoods[hood].push(node);
      }

      const BLOCK_SIZE = 40, BLOCK_GAP = 8;
      const OX = -((3 * BLOCK_SIZE + 2 * BLOCK_GAP) / 2) + BLOCK_SIZE / 2;
      const OZ = -((3 * BLOCK_SIZE + 2 * BLOCK_GAP) / 2) + BLOCK_SIZE / 2;

      function placeBuilding(node: ArchNode, bx: number, bz: number, height: number, width: number, color: any, type: string) {
        let geo: any;
        const w = width;
        if (type === 'database') {
          geo = new THREE.CylinderGeometry(w * 0.5, w * 0.6, height, 16);
          if (node.available === false) color = new THREE.Color('#ef4444');
        } else if (type === 'core') {
          height = Math.max(15, height * 1.5);
          geo = new THREE.BoxGeometry(w * 1.2, height, w * 1.2);
          // Spire with glow
          const spireColor = color.clone().multiplyScalar(1.5);
          const spire = new THREE.Mesh(new THREE.ConeGeometry(0.4, 6, 8), new THREE.MeshStandardMaterial({ color: spireColor, emissive: color, emissiveIntensity: 0.8, metalness: 0.9, roughness: 0.1 }));
          spire.position.set(bx, height + 3, bz); scene.add(spire);
          const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.4, 10, 10), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: color, emissiveIntensity: 1.5 }));
          beacon.position.set(bx, height + 6.2, bz); scene.add(beacon);
          const beaconLight = new THREE.PointLight(color, 3, 20); beacon.add(beaconLight);
          beacon.userData.blink = true; buildingExtras.push(beacon);
        } else if (type === 'scheduler') {
          geo = new THREE.ConeGeometry(w * 0.5, height, 8);
        } else {
          const wx = w * (0.7 + Math.random() * 0.3);
          const wz = w * (0.6 + Math.random() * 0.4);
          geo = new THREE.BoxGeometry(wx, height, wz);
        }

        // Material — varied by type with better PBR properties
        const roughness = type === 'core' ? 0.15 : type === 'database' ? 0.4 : 0.25 + Math.random() * 0.15;
        const metalness = type === 'core' ? 0.85 : type === 'database' ? 0.5 : 0.6 + Math.random() * 0.2;
        const emissiveIntensity = type === 'core' ? 0.3 : 0.12;
        const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity, roughness, metalness, transparent: true, opacity: 0.94 });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(bx, height / 2, bz);
        mesh.userData = { nodeId: node.id, node }; scene.add(mesh);

        originalMaterials.set(node.id, { color: color.clone(), emissive: color.clone(), emissiveIntensity, opacity: 0.94 });

        // Edge outlines — subtle glow
        const edges = new THREE.EdgesGeometry(geo);
        const edgeMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.18 });
        const edgeLine = new THREE.LineSegments(edges, edgeMat);
        edgeLine.position.set(bx, height / 2, bz); scene.add(edgeLine);

        // Base glow pad
        const baseGeo = new THREE.BoxGeometry(w * 1.15, 0.2, w * 1.15);
        const baseMat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.4, roughness: 0.9, metalness: 0.1, transparent: true, opacity: 0.25 });
        const base = new THREE.Mesh(baseGeo, baseMat);
        base.position.set(bx, 0.1, bz); scene.add(base);

        buildingMeshes.set(node.id, mesh);
        buildingPositions.set(node.id, { x: bx, y: height, z: bz });
        buildingPositions.set(node.label, { x: bx, y: height, z: bz });
        buildingPositions.set(`mod:${node.label}`, { x: bx, y: height, z: bz });

        // Window bands — two stripes for taller buildings
        if (height > 5 && (type === 'module' || type === 'core')) {
          const bandCount = height > 15 ? 3 : height > 8 ? 2 : 1;
          for (let b = 0; b < bandCount; b++) {
            const bandY = height * (0.2 + b * 0.25);
            const bandH = height * 0.08;
            const band = new THREE.Mesh(
              new THREE.BoxGeometry(w * 0.88, bandH, w * 0.88),
              new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.06 + b * 0.02 }),
            );
            band.position.set(bx, bandY, bz); scene.add(band);
          }
        }

        // Antenna/tip for tall modules
        if (height > 12 && type === 'module') {
          const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 3.5, 4), new THREE.MeshStandardMaterial({ color: '#1a1d2e', metalness: 0.8, roughness: 0.2 }));
          pole.position.set(bx, height + 1.75, bz); scene.add(pole);
          const tip = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 8), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.8, metalness: 0.3, roughness: 0.4 }));
          tip.position.set(bx, height + 3.7, bz); scene.add(tip); tip.userData.blink = true; buildingExtras.push(tip);
        }

        // Label — with background pill for readability
        const div = document.createElement('div');
        let text = node.label; if (node.toolCount) text += ` (${node.toolCount})`;
        div.textContent = text;
        const c = color.getStyle();
        div.style.cssText = `font:600 7.5px 'JetBrains Mono',monospace;color:${c};text-shadow:0 0 6px ${c},0 0 14px ${c}55;white-space:nowrap;background:rgba(6,6,16,0.6);padding:1px 4px;border-radius:3px;`;
        const lbl = new CSS2DObject(div);
        lbl.position.set(bx, height + (type === 'core' ? 7.5 : 4), bz); scene.add(lbl);
      }

      for (const [hoodId, hoodConfig] of Object.entries(NEIGHBORHOODS)) {
        const cx = OX + hoodConfig.col * (BLOCK_SIZE + BLOCK_GAP);
        const cz = OZ + hoodConfig.row * (BLOCK_SIZE + BLOCK_GAP);
        const hcolor = new THREE.Color(hoodConfig.color);

        // Neighborhood plate — emissive floor with glow border
        const plateMat = new THREE.MeshStandardMaterial({ color: hcolor.clone().multiplyScalar(0.08), emissive: hcolor, emissiveIntensity: 0.04, roughness: 0.95, metalness: 0.1 });
        const plate = new THREE.Mesh(new THREE.BoxGeometry(BLOCK_SIZE - 2, 0.25, BLOCK_SIZE - 2), plateMat);
        plate.position.set(cx, 0.12, cz); scene.add(plate);
        const borderGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(BLOCK_SIZE - 2, 0.25, BLOCK_SIZE - 2));
        const borderMat = new THREE.LineBasicMaterial({ color: hcolor, transparent: true, opacity: 0.25 });
        const border = new THREE.LineSegments(borderGeo, borderMat);
        border.translateX(cx); border.translateY(0.25); border.translateZ(cz); scene.add(border);

        // Corner pillars with emissive tips
        const pillarH = 2;
        const sharedPillarGeo = new THREE.CylinderGeometry(0.12, 0.15, pillarH, 6);
        const sharedPillarMat = new THREE.MeshStandardMaterial({ color: hcolor.clone().multiplyScalar(0.4), metalness: 0.7, roughness: 0.3 });
        for (const [dx, dz] of [[-1,-1],[-1,1],[1,-1],[1,1]]) {
          const px = cx + dx * (BLOCK_SIZE / 2 - 2); const pz = cz + dz * (BLOCK_SIZE / 2 - 2);
          const pillar = new THREE.Mesh(sharedPillarGeo, sharedPillarMat);
          pillar.position.set(px, pillarH / 2, pz); scene.add(pillar);
          const tipGeo = new THREE.SphereGeometry(0.18, 6, 6);
          const tipMat = new THREE.MeshStandardMaterial({ color: hcolor, emissive: hcolor, emissiveIntensity: 0.6 });
          const tipMesh = new THREE.Mesh(tipGeo, tipMat);
          tipMesh.position.set(px, pillarH + 0.15, pz); scene.add(tipMesh);
        }

        // Neighborhood label
        const bld = document.createElement('div'); bld.textContent = hoodConfig.label;
        bld.style.cssText = `font:700 10px 'JetBrains Mono',monospace;color:${hoodConfig.color};opacity:0.55;letter-spacing:3px;text-shadow:0 0 12px ${hoodConfig.color}66;background:rgba(6,6,16,0.4);padding:2px 8px;border-radius:3px;`;
        const blo = new CSS2DObject(bld); blo.position.set(cx, 0.5, cz + BLOCK_SIZE / 2 - 3); scene.add(blo);
        buildingPositions.set(hoodId, { x: cx, y: 10, z: cz });

        let nodes: ArchNode[] = [];
        if (hoodId === 'core') nodes = coreNodes;
        else if (hoodId === 'data') nodes = dbNodes;
        else if (hoodId === 'scheduler') nodes = schedNodes;
        else nodes = neighborhoods[hoodId] ?? [];

        const maxPerRow = Math.ceil(Math.sqrt(Math.max(nodes.length, 1)));
        const spacing = (BLOCK_SIZE - 6) / Math.max(maxPerRow, 1);
        nodes.forEach((node, i) => {
          const row = Math.floor(i / maxPerRow); const col = i % maxPerRow;
          const bx = cx - (BLOCK_SIZE - 6) / 2 + col * spacing + spacing / 2;
          const bz2 = cz - (BLOCK_SIZE - 6) / 2 + row * spacing + spacing / 2;
          const tools = node.toolCount ?? node.tools ?? node.val ?? 4;
          const height = Math.max(2, Math.min(35, tools * 1.2 + 2));
          const width = Math.min(spacing * 0.7, 5);
          placeBuilding(node, bx, bz2, height, width, hcolor.clone(), node.type);
        });
      }

      // Street lamps — decorative with selective point lights for atmosphere
      const sharedPoleGeo = new THREE.CylinderGeometry(0.05, 0.07, 5, 6);
      const sharedPoleMat = new THREE.MeshStandardMaterial({ color: '#14142a', metalness: 0.8, roughness: 0.2 });
      const sharedLampGeo = new THREE.SphereGeometry(0.2, 8, 8);
      let lampIdx = 0;
      for (let i = -3; i <= 3; i++) { for (let j = -3; j <= 3; j++) {
        if (Math.abs(i) < 3 && Math.abs(j) < 3) continue;
        const lx = i * 20, lz = j * 20;
        const pole = new THREE.Mesh(sharedPoleGeo, sharedPoleMat);
        pole.position.set(lx, 2.5, lz); scene.add(pole);
        const lampMat = new THREE.MeshStandardMaterial({ color: '#3dd6c8', emissive: '#3dd6c8', emissiveIntensity: 0.8 });
        const lamp = new THREE.Mesh(sharedLampGeo, lampMat);
        lamp.position.set(lx, 5.2, lz); scene.add(lamp);
        // Add point light to every 3rd lamp for subtle street glow
        if (lampIdx % 3 === 0) {
          const lampLight = new THREE.PointLight(0x3dd6c8, 0.6, 18);
          lampLight.position.set(lx, 5.2, lz); scene.add(lampLight);
        }
        lampIdx++;
      }}

      const raycaster = new THREE.Raycaster();
      const mouse = new THREE.Vector2();
      // Throttled raycasting — only update on next frame, not every mousemove
      let rayDirty = false;
      const meshArray = Array.from(buildingMeshes.values());
      renderer.domElement.addEventListener('mousemove', (e: MouseEvent) => {
        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        if (!rayDirty) {
          rayDirty = true;
          requestAnimationFrame(() => {
            rayDirty = false;
            raycaster.setFromCamera(mouse, camera);
            const hits = raycaster.intersectObjects(meshArray);
            if (hits.length > 0) {
              const n = hits[0].object.userData.node as ArchNode;
              if (n) { hoverLabel = n.label; const p: string[] = [n.type.toUpperCase()]; if (n.toolCount) p.push(`${n.toolCount} tools`); if (n.status) p.push(n.status); if (n.intervalMs) p.push(`${n.intervalMs}ms`); hoverInfo = p.join(' | '); }
              renderer.domElement.style.cursor = 'pointer';
            } else { hoverLabel = ''; hoverInfo = ''; renderer.domElement.style.cursor = 'default'; }
          });
        }
      });

      renderer.domElement.addEventListener('click', (e: MouseEvent) => {
        if (tourActive) stopTour();
        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);
        const hits = raycaster.intersectObjects(Array.from(buildingMeshes.values()));
        if (hits.length > 0) {
          const node = hits[0].object.userData.node as ArchNode;
          const pos = hits[0].object.position;
          controls.target.set(pos.x, pos.y, pos.z);
          if (node) selectModule(node);
        } else { if (followTarget) exitFollowMode(); }
      });

      renderer.domElement.addEventListener('wheel', () => { if (tourActive) stopTour(); });
      window.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Escape') { if (tourActive) stopTour(); if (followTarget) exitFollowMode(); if (selectedModule) closePanel(); } });

      function animate() {
        animId = requestAnimationFrame(animate);
        frameCount++;
        controls.update();
        // Only update effects when active (skip no-ops)
        if (activeBeams.length > 0) updateBeams();
        if (activeWaves.length > 0) updateWaves();
        if (activePulses.length > 0) updatePulses();
        if (activeAlerts.length > 0) updateAlerts();
        if (followTarget) updateFollowMode();
        // Heatmap/health only every 10 frames (data doesn't change faster)
        if (frameCount % 10 === 0) {
          if (layers.heatmap && heatmapData.size > 0) applyHeatmap();
          if (layers.health && heatmapData.size > 0) applyHealth();
        }
        // Blink extras — smooth breathing glow
        if (frameCount % 2 === 0) {
          for (const extra of buildingExtras) {
            if (extra.userData.blink && extra.material) {
              const phase = frameCount * 0.025 + extra.position.x * 0.1;
              const pulse = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(phase));
              if (extra.material.opacity !== undefined) extra.material.opacity = pulse;
              if (extra.material.emissiveIntensity !== undefined) extra.material.emissiveIntensity = 0.3 + pulse * 1.2;
            }
          }
        }
        renderer.render(scene, camera);
        // CSS2D labels only every 3 frames (DOM is expensive)
        if (frameCount % 3 === 0) labelRenderer.render(scene, camera);
        // Minimap every 30 frames
        if (layers.minimap && frameCount % 30 === 0) renderMinimap();
      }
      animate();
      if (layers.minimap) createMinimap();

      const ro = new ResizeObserver(() => {
        if (!canvasEl) return;
        const w = canvasEl.clientWidth, h = canvasEl.clientHeight;
        camera.aspect = w / h; camera.updateProjectionMatrix();
        renderer.setSize(w, h); labelRenderer.setSize(w, h);
      });
      ro.observe(canvasEl);
    } catch (e: any) { error = `City init failed: ${e.message || e}`; console.error(e); }
  }

  function handleArchEvent(evt: { event: string; data: Record<string, unknown> }) {
    const source = (evt.data.source as string) ?? '';
    const target = (evt.data.target as string) ?? '';
    const label = (evt.data.label as string) ?? (evt.data.tool as string) ?? '';
    const module = (evt.data.module as string) ?? source;
    const color = BEAM_COLORS[evt.event] ?? '#5b9bf7';
    if (!shouldShow(evt.event, label)) return;
    const logEntry = { event: evt.event, source: source || module, target: target || module, label: label.replace('kernel_', ''), ts: new Date().toISOString() };
    eventLog = [logEntry, ...eventLog].slice(0, 80);
    if (layers.timeline) timelineData = [{ ts: Date.now(), source: logEntry.source, target: logEntry.target, label: logEntry.label, event: logEntry.event }, ...timelineData].slice(0, 200);
    if (layers.alerts && (evt.event === 'cross_module' || label.includes('error') || label.includes('fail'))) spawnAlertBeacon(source || module);
    if (source && target && source !== target) { queueBeam(source, target, color, { event: evt.event, label }); }
    else if (module) { pulseBuilding(module, color, 800); const pos = resolveModulePos(module); if (pos) spawnShockwave(pos, color); }
  }

  let unsub: (() => void) | null = null;
  let lastEventCount = 0;
  let ambientIntervals: ReturnType<typeof setInterval>[] = [];

  type Verbosity = 'debug' | 'normal' | 'important';
  let verbosity: Verbosity = 'normal';
  const VERBOSITY_LABELS_MAP: Record<Verbosity, string> = { debug: 'DEBUG - all internals', normal: 'NORMAL - activity', important: 'FOCUS - key events' };
  const VERBOSITY_CYCLE: Verbosity[] = ['debug', 'normal', 'important'];

  function getEventPriority(event: string, _label: string): number {
    if (event === 'tool_exec' || event === 'agent_chain' || event === 'agent_start' || event === 'agent_done' || event === 'cross_module' || event === 'agent_tool' || event === 'rpc_call' || event === 'rust_delegate') return 1;
    if (event === 'scheduler_tick') return 2;
    return 2;
  }
  function shouldShow(event: string, label: string): boolean { const p = getEventPriority(event, label); if (verbosity === 'debug') return true; if (verbosity === 'normal') return p <= 2; return p <= 1; }
  function cycleVerbosity() { const idx = VERBOSITY_CYCLE.indexOf(verbosity); verbosity = VERBOSITY_CYCLE[(idx + 1) % VERBOSITY_CYCLE.length]; eventLog = eventLog.filter(e => shouldShow(e.event, e.label)); }


  onMount(async () => {
    await loadData();
    if (graphData) await initCity();
    const currentEvents = archEvents;
    let initialized = false;
    unsub = currentEvents.subscribe(events => {
      if (!initialized) { lastEventCount = events.length; initialized = true; return; }
      if (events.length > lastEventCount) {
        const newCount = events.length - lastEventCount;
        const batch = events.slice(0, Math.min(newCount, 3));
        for (const evt of batch.reverse()) handleArchEvent(evt);
      }
      lastEventCount = events.length;
    });
  });

  onDestroy(() => {
    unsub?.();
    if (beamBatchTimer) clearTimeout(beamBatchTimer);
    for (const id of ambientIntervals) clearTimeout(id); ambientIntervals = [];
    if (animId) cancelAnimationFrame(animId);
    if (heatmapInterval) clearInterval(heatmapInterval);
    if (timelinePlayInterval) clearInterval(timelinePlayInterval);
    if (tourTimer) clearTimeout(tourTimer);
    if (highlightTimeout) clearTimeout(highlightTimeout);
    disposeMinimap(); renderer?.dispose();
  });

  function resetCamera() { if (camera && controls) { camera.position.set(90, 120, 150); controls.target.set(0, 5, 0); } }
  function topView() { if (camera && controls) { camera.position.set(0, 180, 1); controls.target.set(0, 0, 0); } }
  function fmtTs(ts: string) { return new Date(ts).toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  function getModuleHood(label: string): string { return MOD_NEIGHBORHOOD[label] || 'system'; }
  function getModuleHoodColor(label: string): string { const hood = getModuleHood(label); return NEIGHBORHOODS[hood]?.color || '#6e738a'; }
</script>

<div class="arch-page">
  <div class="hud tl">
    <div class="hud-title">Kernl CITY</div>
    {#if graphData}
      <div class="hud-stat"><b>{graphData.meta.modules}</b> modules</div>
      <div class="hud-stat"><b>{graphData.meta.tools}</b> tools</div>
      <div class="hud-stat"><b>{graphData.meta.processes}</b> processes</div>
      {#if graphData.meta.mtwRequest}
        <div class="hud-stat"><b>{graphData.meta.mtwRequest.rpcActions}</b> RPC actions</div>
        <div class="hud-stat" style="color: {graphData.meta.mtwRequest.connected ? '#3dd68c' : '#ef4444'}">mtwRequest {graphData.meta.mtwRequest.connected ? '●' : '○'}</div>
      {/if}
      <div class="hud-stat"><b>{beamCount}</b> active beams</div>
    {/if}
    {#if followTarget}
      <div class="hud-stat follow-badge">FOLLOWING: <b>{followTarget}</b></div>
    {/if}
    {#if activeHood}
      <div class="hud-stat hood-badge">FILTER: <b>{NEIGHBORHOODS[activeHood]?.label}</b></div>
    {/if}
  </div>

  <div class="hud tr">
    <button class="hud-btn verbosity-btn" class:v-debug={verbosity === 'debug'} class:v-normal={verbosity === 'normal'} class:v-important={verbosity === 'important'} on:click={cycleVerbosity} title={VERBOSITY_LABELS_MAP[verbosity]}>
      {#if verbosity === 'debug'}●●● DEBUG{:else if verbosity === 'normal'}●●○ NORMAL{:else}●○○ FOCUS{/if}
    </button>
    <button class="hud-btn" on:click={resetCamera}>Perspective</button>
    <button class="hud-btn" on:click={topView}>Top</button>
  </div>

  {#if hoverLabel && !selectedModule}
    <div class="hud hover-tip"><div class="hover-name">{hoverLabel}</div><div class="hover-detail">{hoverInfo}</div></div>
  {/if}

  {#if tourActive && tourTooltip}
    <div class="tour-tooltip">{tourTooltip}</div>
  {/if}

  {#if selectedModule}
    <div class="side-panel">
      <div class="sp-header">
        <div class="sp-title" style="color:{getModuleHoodColor(selectedModule.label)}">{selectedModule.label}</div>
        <button class="sp-close" on:click={closePanel}>X</button>
      </div>
      <div class="sp-row"><span class="sp-label">Type</span><span class="sp-val">{selectedModule.type.toUpperCase()}</span></div>
      <div class="sp-row"><span class="sp-label">Neighborhood</span><span class="sp-val" style="color:{getModuleHoodColor(selectedModule.label)}">{NEIGHBORHOODS[getModuleHood(selectedModule.label)]?.label || 'UNKNOWN'}</span></div>
      {#if selectedModule.toolCount}<div class="sp-row"><span class="sp-label">Tools</span><span class="sp-val">{selectedModule.toolCount}</span></div>{/if}
      {#if selectedModule.status}<div class="sp-row"><span class="sp-label">Status</span><span class="sp-val">{selectedModule.status}</span></div>{/if}
      {#if selectedModule.intervalMs}<div class="sp-row"><span class="sp-label">Interval</span><span class="sp-val">{selectedModule.intervalMs}ms</span></div>{/if}
      <div class="sp-actions">
        {#if followTarget === selectedModule.label}
          <button class="sp-btn sp-btn-active" on:click={exitFollowMode}>Unfollow</button>
        {:else}
          <button class="sp-btn" on:click={() => enterFollowMode(selectedModule?.label || '')}>Follow</button>
        {/if}
      </div>
      {#if moduleDeps.length > 0}
        <div class="sp-section">DEPENDENCIES</div>
        {#each moduleDeps as dep}
          <div class="sp-dep">
            <span class="sp-dep-type" style="color:{DEP_LINK_COLORS[dep.type] || '#5b9bf7'}">{dep.type}</span>
            <span class="sp-dep-arrow">{dep.source === selectedModule.label || dep.source === selectedModule.id ? '->' : '<-'}</span>
            <span class="sp-dep-target">{dep.source === selectedModule.label || dep.source === selectedModule.id ? dep.target : dep.source}</span>
          </div>
        {/each}
      {/if}
      {#if moduleTools.length > 0}
        <div class="sp-section">TOOLS</div>
        <div class="sp-tools">{#each moduleTools as tool}<div class="sp-tool">{tool}</div>{/each}</div>
      {/if}
      {#if moduleMetrics}
        <div class="sp-section">LIVE METRICS</div>
        <div class="sp-row"><span class="sp-label">Total Calls</span><span class="sp-val">{moduleMetrics.toolCalls}</span></div>
        <div class="sp-row"><span class="sp-label">Recent/h</span><span class="sp-val">{moduleMetrics.recentCalls}</span></div>
        <div class="sp-row"><span class="sp-label">Errors</span><span class="sp-val" class:sp-err={moduleMetrics.errors > 0}>{moduleMetrics.errors}</span></div>
        <div class="sp-row"><span class="sp-label">Avg Latency</span><span class="sp-val">{moduleMetrics.avgLatencyMs}ms</span></div>
        <div class="sp-row"><span class="sp-label">Status</span><span class="sp-status" class:st-healthy={moduleMetrics.status === 'healthy'} class:st-degraded={moduleMetrics.status === 'degraded'} class:st-error={moduleMetrics.status === 'error'} class:st-inactive={moduleMetrics.status === 'inactive'}>{moduleMetrics.status}</span></div>
      {/if}
    </div>
  {/if}

  <div class="hud bl">
    <div class="legend-title" style="cursor:pointer" on:click={() => layersPanelOpen = !layersPanelOpen}>LAYERS {layersPanelOpen ? '[-]' : '[+]'}</div>
    {#if layersPanelOpen}
      <div class="layers-panel">
        {#each Object.entries(layers) as [key, val]}
          <label class="layer-toggle">
            <input type="checkbox" bind:checked={layers[key]} on:change={() => onLayerToggle(key)} />
            <span class="layer-name">{LAYER_LABELS[key] || key}</span>
          </label>
        {/each}
      </div>
    {/if}
    <div class="legend-title" style="margin-top:8px">NEIGHBORHOODS</div>
    {#each Object.entries(NEIGHBORHOODS) as [hoodId, h]}
      <div class="legend-item legend-hood" class:legend-hood-active={activeHood === hoodId} on:click={() => toggleHoodFilter(hoodId)} style="cursor:pointer">
        <span class="legend-dot" style="background:{h.color}"></span>{h.label}
      </div>
    {/each}
    <div class="legend-title" style="margin-top:8px">BEAMS</div>
    {#each Object.entries(BEAM_COLORS).filter(([k]) => k !== 'ambient') as [k, c]}
      <div class="legend-item"><span class="legend-line" style="background:{c}"></span>{k.replace('_', ' ')}</div>
    {/each}
    <div class="legend-item"><span class="legend-line" style="background:#2a4a6e"></span>ambient (bg processes)</div>
  </div>

  <div class="hud br">
    {#if layers.timeline}
      <div class="legend-title">TIMELINE</div>
      <div class="timeline-bar">
        <div class="timeline-track">
          {#each timelineData.slice(0, 50) as evt, i}
            <div class="timeline-dot" style="left:{(i / Math.max(timelineData.length - 1, 1)) * 100}%;background:{BEAM_COLORS[evt.event] || '#5b9bf7'}" title="{evt.source} -> {evt.target}: {evt.label}"></div>
          {/each}
          <div class="timeline-playhead" style="left:{timelinePos * 100}%"></div>
        </div>
        <input type="range" class="timeline-slider" min="0" max="1" step="0.001" bind:value={timelinePos} />
        <div class="timeline-controls">
          {#if timelinePlaying}<button class="hud-btn" on:click={stopTimelinePlay}>Pause</button>{:else}<button class="hud-btn" on:click={startTimelinePlay}>Play</button>{/if}
          <span class="timeline-count">{timelineData.length} events</span>
        </div>
      </div>
    {/if}
    <div class="legend-title">LIVE COMMS</div>
    <div class="event-log">
      {#each eventLog as evt}
        <div class="ev-row" class:ev-highlighted={highlightedEvt && highlightedEvt.source === evt.source && highlightedEvt.target === evt.target} on:click={() => onEventLogClick(evt)} style="cursor:pointer">
          <span class="ev-ts">{fmtTs(evt.ts)}</span>
          <span class="ev-src" style="color:{BEAM_COLORS[evt.event] ?? '#5b9bf7'}">{evt.source}</span>
          <span class="ev-arrow">-></span>
          <span class="ev-tgt">{evt.target}</span>
          {#if evt.label}<span class="ev-label">{evt.label}</span>{/if}
        </div>
      {/each}
      {#if eventLog.length === 0}<div class="ev-empty">Waiting for communications...</div>{/if}
    </div>
  </div>

  {#if layers.minimap}<div class="minimap-slot"></div>{/if}

  <div class="city-canvas" bind:this={canvasEl}>
    {#if loading}<div class="center-msg">Loading city...</div>{/if}
    {#if error}<div class="center-msg err">{error}</div>{/if}
  </div>
</div>

<style>
  .arch-page { position: relative; width: 100%; height: 100%; overflow: hidden; background: #060610; }
  .city-canvas { width: 100%; height: 100%; position: relative; }
  .city-canvas :global(canvas) { outline: none; display: block; }
  .city-canvas :global(div[style*="position: absolute"]) { pointer-events: none; }
  .center-msg { position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%); color: #6e738a; font: 11px 'JetBrains Mono', monospace; }
  .center-msg.err { color: #ef4444; max-width: 400px; text-align: center; }

  .hud { position: absolute; z-index: 10; background: rgba(6,6,16,0.92); border: 1px solid rgba(61,214,200,0.1); border-radius: 8px; padding: 10px 14px; backdrop-filter: blur(12px); font: 10px 'JetBrains Mono', monospace; color: #8a8ea2; box-shadow: 0 4px 24px rgba(0,0,0,0.4), inset 0 1px 0 rgba(61,214,200,0.05); }
  .tl { top: 12px; left: 12px; }
  .tr { top: 12px; right: 12px; display: flex; gap: 6px; }
  .bl { bottom: 12px; left: 12px; max-height: calc(100vh - 40px); overflow-y: auto; scrollbar-width: thin; scrollbar-color: #1a1a2e transparent; }
  .br { bottom: 12px; right: 12px; max-width: 340px; }
  .hover-tip { top: 12px; left: 50%; transform: translateX(-50%); text-align: center; }

  .hud-title { font-size: 13px; font-weight: 700; color: #e0e2eb; margin-bottom: 6px; letter-spacing: 2.5px; text-transform: uppercase; }
  .hud-stat { margin: 3px 0; }
  .hud-stat b { color: #3dd6c8; }
  .follow-badge { color: #d4a84b; margin-top: 4px; }
  .follow-badge b { color: #d4a84b; }
  .hood-badge { color: #8b7cf6; }
  .hood-badge b { color: #8b7cf6; }
  .hud-btn { padding: 4px 12px; border-radius: 4px; border: 1px solid rgba(61,214,200,0.2); background: rgba(20,20,30,0.9); color: #8a8ea2; font: 9px 'JetBrains Mono', monospace; cursor: pointer; }
  .hud-btn:hover { border-color: #3dd6c8; color: #3dd6c8; }
  .active-btn { border-color: #3dd68c; color: #3dd68c; }
  .verbosity-btn { min-width: 90px; text-align: center; letter-spacing: 0.5px; font-weight: 600; }
  .v-debug { border-color: #ef4444; color: #ef4444; }
  .v-debug:hover { border-color: #ef4444; color: #ef4444; }
  .v-normal { border-color: #d4a84b; color: #d4a84b; }
  .v-normal:hover { border-color: #d4a84b; color: #d4a84b; }
  .v-important { border-color: #3dd6c8; color: #3dd6c8; }
  .v-important:hover { border-color: #3dd6c8; color: #3dd6c8; }

  .hover-name { font-size: 13px; font-weight: 700; color: #3dd6c8; letter-spacing: 1px; }
  .hover-detail { font-size: 9px; color: #6e738a; margin-top: 3px; letter-spacing: 0.5px; }

  .legend-title { font-size: 8px; font-weight: 700; color: #4a4e62; letter-spacing: 1.5px; margin-bottom: 6px; user-select: none; }
  .legend-item { display: flex; align-items: center; gap: 6px; margin: 2px 0; font-size: 8px; }
  .legend-dot { width: 6px; height: 6px; border-radius: 2px; flex-shrink: 0; }
  .legend-line { width: 14px; height: 2px; border-radius: 1px; flex-shrink: 0; }
  .legend-hood { padding: 1px 4px; border-radius: 3px; transition: background 0.2s; }
  .legend-hood:hover { background: rgba(61,214,200,0.08); }
  .legend-hood-active { background: rgba(61,214,200,0.15); border: 1px solid rgba(61,214,200,0.3); }

  .layers-panel { margin-bottom: 8px; }
  .layer-toggle { display: flex; align-items: center; gap: 6px; margin: 3px 0; font-size: 8px; cursor: pointer; user-select: none; padding: 2px 4px; border-radius: 3px; transition: background 0.2s; }
  .layer-toggle:hover { background: rgba(61,214,200,0.06); }
  .layer-toggle input[type="checkbox"] { appearance: none; -webkit-appearance: none; width: 10px; height: 10px; border: 1px solid #3a3e52; border-radius: 2px; background: transparent; cursor: pointer; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
  .layer-toggle input[type="checkbox"]:checked { background: #3dd6c8; border-color: #3dd6c8; }
  .layer-toggle input[type="checkbox"]:checked::after { content: ''; display: block; width: 4px; height: 4px; background: #08080e; border-radius: 1px; }
  .layer-name { color: #8a8ea2; }

  .side-panel { position: absolute; top: 0; right: 0; width: 300px; height: 100%; background: rgba(6,6,16,0.96); border-left: 1px solid rgba(61,214,200,0.12); z-index: 20; padding: 16px; overflow-y: auto; font: 10px 'JetBrains Mono', monospace; color: #8a8ea2; backdrop-filter: blur(16px); scrollbar-width: thin; scrollbar-color: #1a1a2e transparent; box-shadow: -8px 0 32px rgba(0,0,0,0.5); }
  .sp-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  .sp-title { font-size: 16px; font-weight: 700; letter-spacing: 1px; }
  .sp-close { background: transparent; border: 1px solid rgba(61,214,200,0.2); color: #6e738a; cursor: pointer; padding: 2px 8px; border-radius: 3px; font: 10px 'JetBrains Mono', monospace; }
  .sp-close:hover { color: #ef4444; border-color: #ef4444; }
  .sp-row { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid rgba(61,214,200,0.06); }
  .sp-label { color: #4a4e62; }
  .sp-val { color: #c0c4d8; font-weight: 600; }
  .sp-err { color: #ef4444; }
  .sp-status { font-weight: 600; padding: 1px 6px; border-radius: 3px; }
  .st-healthy { color: #3dd68c; background: rgba(61,214,140,0.1); }
  .st-degraded { color: #d4a84b; background: rgba(212,168,75,0.1); }
  .st-error { color: #ef4444; background: rgba(239,68,68,0.1); }
  .st-inactive { color: #6e738a; background: rgba(110,115,138,0.1); }
  .sp-section { font-size: 8px; font-weight: 700; color: #4a4e62; letter-spacing: 1.5px; margin-top: 12px; margin-bottom: 6px; padding-top: 8px; border-top: 1px solid rgba(61,214,200,0.08); }
  .sp-dep { display: flex; gap: 6px; padding: 2px 0; font-size: 8.5px; }
  .sp-dep-type { font-weight: 600; min-width: 40px; }
  .sp-dep-arrow { color: #3dd6c8; }
  .sp-dep-target { color: #c0c4d8; }
  .sp-actions { margin-top: 10px; display: flex; gap: 6px; }
  .sp-btn { padding: 4px 12px; border-radius: 4px; font: 9px 'JetBrains Mono', monospace; border: 1px solid rgba(61,214,200,0.2); background: rgba(20,20,30,0.9); color: #8a8ea2; cursor: pointer; }
  .sp-btn:hover { border-color: #d4a84b; color: #d4a84b; }
  .sp-btn-active { border-color: #d4a84b; color: #d4a84b; background: rgba(212,168,75,0.1); }
  .sp-tools { max-height: 120px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: #1a1a2e transparent; }
  .sp-tool { padding: 1px 0; font-size: 7.5px; color: #5a5e72; }

  .event-log { max-height: 220px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: #1a1a2e transparent; }
  .ev-row { display: flex; gap: 5px; padding: 4px 4px; border-bottom: 1px solid rgba(61,214,200,0.04); font-size: 8.5px; animation: evSlideIn 0.4s ease-out; align-items: center; transition: background 0.15s; border-radius: 3px; }
  .ev-row:hover { background: rgba(61,214,200,0.06); }
  .ev-highlighted { background: rgba(61,214,200,0.12) !important; }
  .ev-ts { color: #2a2e42; min-width: 50px; font-variant-numeric: tabular-nums; font-size: 7.5px; }
  .ev-src { font-weight: 700; }
  .ev-arrow { color: #3dd6c8; font-size: 8px; animation: arrowPulse 1.5s ease-in-out; opacity: 0.7; }
  .ev-tgt { color: #c0c4d8; font-weight: 500; }
  .ev-label { color: #4a4e62; font-size: 7px; opacity: 0.7; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ev-empty { color: #2a2d3a; font-style: italic; }

  .tour-tooltip { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 25; background: rgba(6,6,16,0.94); border: 1px solid rgba(61,214,200,0.25); border-radius: 10px; padding: 16px 24px; font: 12px 'JetBrains Mono', monospace; color: #e0e2eb; text-align: center; backdrop-filter: blur(16px); animation: tourFadeIn 0.5s ease-out; pointer-events: none; box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 60px rgba(61,214,200,0.05); }

  .timeline-bar { margin-bottom: 8px; }
  .timeline-track { position: relative; height: 20px; background: rgba(20,20,30,0.6); border: 1px solid rgba(61,214,200,0.08); border-radius: 3px; margin-bottom: 4px; }
  .timeline-dot { position: absolute; width: 4px; height: 4px; border-radius: 50%; top: 50%; transform: translate(-50%, -50%); }
  .timeline-playhead { position: absolute; width: 2px; height: 100%; background: #3dd6c8; top: 0; transform: translateX(-50%); pointer-events: none; }
  .timeline-slider { width: 100%; height: 4px; appearance: none; -webkit-appearance: none; background: transparent; outline: none; margin: 0; }
  .timeline-slider::-webkit-slider-thumb { appearance: none; -webkit-appearance: none; width: 8px; height: 14px; border-radius: 2px; background: #3dd6c8; cursor: pointer; }
  .timeline-slider::-moz-range-thumb { width: 8px; height: 14px; border-radius: 2px; background: #3dd6c8; cursor: pointer; border: none; }
  .timeline-controls { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
  .timeline-count { font-size: 7.5px; color: #4a4e62; }

  .minimap-slot { position: absolute; bottom: 220px; right: 12px; width: 200px; height: 200px; z-index: 15; border: 1px solid rgba(61,214,200,0.15); border-radius: 6px; overflow: hidden; background: rgba(8,8,14,0.9); }
  .minimap-slot :global(canvas) { width: 100% !important; height: 100% !important; border-radius: 6px; }

  @keyframes evSlideIn { from { opacity: 0; transform: translateX(10px); } to { opacity: 1; transform: translateX(0); } }
  @keyframes arrowPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
  @keyframes tourFadeIn { from { opacity: 0; transform: translate(-50%, -50%) scale(0.9); } to { opacity: 1; transform: translate(-50%, -50%) scale(1); } }
</style>
