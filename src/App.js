import { useState, useEffect, useRef, useCallback } from "react";

// ─── Hex grid math (axial coordinates, flat-top) ───────────────────────────
// We simulate H3 res-10 style hexagons using axial (q,r) coordinates.
// Each hex cell is ~65m wide at res-10. We use a fixed pixel size for display.

const HEX_SIZE = 18; // px, radius of each hexagon

function hexToId(q, r) { return `${q},${r}`; }
function idToHex(id) { const [q, r] = id.split(",").map(Number); return { q, r }; }

// Flat-top hex: pixel center from axial coords
function hexToPixel(q, r, size = HEX_SIZE) {
  const x = size * (3 / 2) * q;
  const y = size * (Math.sqrt(3) / 2 * q + Math.sqrt(3) * r);
  return { x, y };
}

// Pixel to nearest axial hex
function pixelToHex(px, py, size = HEX_SIZE) {
  const q = ((2 / 3) * px) / size;
  const r = ((-1 / 3) * px + (Math.sqrt(3) / 3) * py) / size;
  return hexRound(q, r);
}

function hexRound(qf, rf) {
  const sf = -qf - rf;
  let q = Math.round(qf), r = Math.round(rf), s = Math.round(sf);
  const dq = Math.abs(q - qf), dr = Math.abs(r - rf), ds = Math.abs(s - sf);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return { q, r };
}

// 6 flat-top neighbors
const NEIGHBORS = [[1,0],[-1,0],[0,1],[0,-1],[1,-1],[-1,1]];
function hexNeighbors(q, r) {
  return NEIGHBORS.map(([dq, dr]) => ({ q: q + dq, r: r + dr }));
}

// Flat-top corners of a hex
function hexCorners(q, r, size = HEX_SIZE) {
  const { x: cx, y: cy } = hexToPixel(q, r, size);
  return Array.from({ length: 6 }, (_, i) => {
    const angle = (Math.PI / 3) * i;
    return [cx + size * Math.cos(angle), cy + size * Math.sin(angle)];
  });
}

// ─── Flood-fill to find interior cells of a closed polygon ring ────────────
function floodFillInterior(ringSet, boundingCells) {
  // bounding box of ring
  let minQ = Infinity, maxQ = -Infinity, minR = Infinity, maxR = -Infinity;
  for (const id of ringSet) {
    const { q, r } = idToHex(id);
    if (q < minQ) minQ = q; if (q > maxQ) maxQ = q;
    if (r < minR) minR = r; if (r > maxR) maxR = r;
  }
  // Start flood from outside corner — guaranteed exterior
  const exterior = new Set();
  const queue = [];
  const seed = { q: minQ - 1, r: minR - 1 };
  const seedId = hexToId(seed.q, seed.r);
  exterior.add(seedId);
  queue.push(seed);

  while (queue.length > 0) {
    const { q, r } = queue.shift();
    for (const nb of hexNeighbors(q, r)) {
      const nid = hexToId(nb.q, nb.r);
      if (exterior.has(nid) || ringSet.has(nid)) continue;
      if (nb.q < minQ - 2 || nb.q > maxQ + 2 || nb.r < minR - 2 || nb.r > maxR + 2) continue;
      exterior.add(nid);
      queue.push(nb);
    }
  }

  // Interior = cells in bounding box not in ring, not exterior
  const interior = [];
  for (let q = minQ; q <= maxQ; q++) {
    for (let r = minR; r <= maxR; r++) {
      const id = hexToId(q, r);
      if (!ringSet.has(id) && !exterior.has(id)) {
        interior.push(id);
      }
    }
  }
  return interior;
}

// ─── Score → green color ────────────────────────────────────────────────────
function scoreToFill(score) {
  const t = Math.min(score / 6, 1);
  const r = Math.round(220 - 190 * t);
  const g = Math.round(240 - 100 * t);
  const b = Math.round(200 - 160 * t);
  return `rgb(${r},${g},${b})`;
}
function scoreToStroke(score) {
  const t = Math.min(score / 6, 1);
  const g = Math.round(140 - 100 * t);
  return `rgb(20,${g},30)`;
}

// ─── Canvas renderer ────────────────────────────────────────────────────────
function drawHexOn(ctx, q, r, fill, stroke, strokeWidth = 0.8, size = HEX_SIZE) {
  const corners = hexCorners(q, r, size);
  ctx.beginPath();
  ctx.moveTo(corners[0][0], corners[0][1]);
  for (let i = 1; i < 6; i++) ctx.lineTo(corners[i][0], corners[i][1]);
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = strokeWidth; ctx.stroke(); }
}

// ─── Simulate GPS path: north/south/east/west in hex steps ─────────────────
// 1 hex step ≈ 65m at H3 res-10 equivalent. We use ~6 steps per 200m, ~3 per 100m.
function buildSimPath(moves) {
  // moves: array of [dq, dr, steps]
  let q = 0, r = 0;
  const pts = [{ q, r }];
  for (const [dq, dr, steps] of moves) {
    for (let i = 0; i < steps; i++) {
      q += dq; r += dr;
      pts.push({ q, r });
    }
  }
  return pts;
}

// Cardinal directions in flat-top axial:
// North ≈ (0,-1), South ≈ (0,1), East ≈ (1,-1) or (1,0), West ≈ (-1,0) or (-1,1)
const N = [0, -1], S = [0, 1], E = [1, -1], W = [-1, 1];

const SCENARIOS = {
  manual: { label: "Draw manually", info: "Click and drag on the canvas to lay a path. When you cross a previously visited cell, the circuit closes automatically." },
  square200: {
    label: "200m square",
    info: "Runs a 200m N → W → S → E square. Watch the circuit close and interior cells go green.",
    moves: [...Array(6).fill([...N,1]),...Array(6).fill([...W,1]),...Array(6).fill([...S,1]),...Array(6).fill([...E,1])].map(([dq,dr]) => [dq,dr,1])
  },
  innerLoop: {
    label: "Outer + inner loop",
    info: "200m outer square first, then a 100m inner loop on the right. Both regions score independently.",
    phases: [
      { moves: [...Array(6).fill([...N,1]),...Array(6).fill([...W,1]),...Array(6).fill([...S,1]),...Array(6).fill([...E,1])].map(([dq,dr])=>[dq,dr,1]), startQ: 0, startR: 0 },
      { moves: [...Array(3).fill([...N,1]),...Array(3).fill([...E,1]),...Array(3).fill([...S,1]),...Array(3).fill([...W,1])].map(([dq,dr])=>[dq,dr,1]), startQ: 3, startR: 0 }
    ]
  },
  doubleCircuit: {
    label: "Double circuit (score ×2)",
    info: "Same 200m square traced twice. Interior cells accumulate score=2 and become a deeper green.",
    phases: [
      { moves: [...Array(6).fill([...N,1]),...Array(6).fill([...W,1]),...Array(6).fill([...S,1]),...Array(6).fill([...E,1])].map(([dq,dr])=>[dq,dr,1]), startQ: 0, startR: 0 },
      { moves: [...Array(6).fill([...N,1]),...Array(6).fill([...W,1]),...Array(6).fill([...S,1]),...Array(6).fill([...E,1])].map(([dq,dr])=>[dq,dr,1]), startQ: 0, startR: 0 }
    ]
  },
  invertedC: {
    label: "Inverted-C edge case",
    info: "After the 200m square closes & resets, trace a U-shape going N→E→N. No circuit closes → no scoring. Open paths never score.",
    phases: [
      { moves: [...Array(6).fill([...N,1]),...Array(6).fill([...W,1]),...Array(6).fill([...S,1]),...Array(6).fill([...E,1])].map(([dq,dr])=>[dq,dr,1]), startQ: 0, startR: 0 },
      { moves: [...Array(4).fill([...N,1]),...Array(4).fill([...E,1]),...Array(4).fill([...N,1])].map(([dq,dr])=>[dq,dr,1]), startQ: 0, startR: 0 }
    ]
  }
};

// ─── Main component ─────────────────────────────────────────────────────────
export default function App() {
  const canvasRef = useRef(null);
  const stateRef = useRef({ path: [], scoredCells: {}, circuitCount: 0 });
  const [stats, setStats] = useState({ path: 0, circuits: 0, captured: 0, maxScore: 0 });
  const [info, setInfo] = useState(SCENARIOS.manual.info);
  const [activeScenario, setActiveScenario] = useState("manual");
  const [flashCells, setFlashCells] = useState([]);
  const animRef = useRef(null);
  const isDrawing = useRef(false);

  const updateStats = useCallback(() => {
    const { path, scoredCells, circuitCount } = stateRef.current;
    const scores = Object.values(scoredCells);
    setStats({
      path: path.length,
      circuits: circuitCount,
      captured: Object.keys(scoredCells).length,
      maxScore: scores.length > 0 ? Math.max(...scores) : 0
    });
  }, []);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const { path, scoredCells } = stateRef.current;
    const ox = W / 2, oy = H / 2;
    ctx.save();
    ctx.translate(ox, oy);

    // Draw scored cells
    for (const [id, score] of Object.entries(scoredCells)) {
      const { q, r } = idToHex(id);
      drawHexOn(ctx, q, r, scoreToFill(score), scoreToStroke(score), 1.0);
    }

    // Draw grid background (faint)
    const gridR = 14;
    for (let q = -gridR; q <= gridR; q++) {
      for (let r = -gridR; r <= gridR; r++) {
        const id = hexToId(q, r);
        if (scoredCells[id]) continue;
        if (path.includes(id)) continue;
        const { x, y } = hexToPixel(q, r);
        if (Math.abs(x) > W / 2 + 20 || Math.abs(y) > H / 2 + 20) continue;
        drawHexOn(ctx, q, r, null, "rgba(80,110,150,0.35)", 0.7);
      }
    }

    // Draw path
    const pathSet = new Set(path);
    path.forEach((id, i) => {
      const { q, r } = idToHex(id);
      const isStart = i === 0;
      const isLast = i === path.length - 1;
      const fill = isStart
        ? "rgba(230,80,80,0.55)"
        : isLast
        ? "rgba(255,200,40,0.65)"
        : "rgba(58,130,220,0.30)";
      const stroke = isStart ? "#c0392b" : isLast ? "#d4a017" : "#2980b9";
      drawHexOn(ctx, q, r, fill, stroke, isStart || isLast ? 1.5 : 0.8);
    });

    // Flash cells
    flashCells.forEach(id => {
      const { q, r } = idToHex(id);
      drawHexOn(ctx, q, r, "rgba(255,255,100,0.5)", "#f1c40f", 1);
    });

    ctx.restore();
    updateStats();
  }, [flashCells, updateStats]);

  useEffect(() => { render(); }, [render]);

  // Resize canvas
  useEffect(() => {
    const resize = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const W = canvas.parentElement.clientWidth;
      canvas.width = W;
      canvas.height = Math.min(460, Math.round(W * 0.58));
      render();
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [render]);

  const closeCircuit = useCallback((loopStartIdx) => {
    const st = stateRef.current;
    const loop = st.path.slice(loopStartIdx);
    const ringSet = new Set(loop);
    const interior = floodFillInterior(ringSet, loop);
    const newFlash = [];
    interior.forEach(id => {
      st.scoredCells[id] = (st.scoredCells[id] || 0) + 1;
      newFlash.push(id);
    });
    loop.forEach(id => {
      st.scoredCells[id] = (st.scoredCells[id] || 0) + 1;
    });
    st.circuitCount++;
    st.path = [];
    setFlashCells(newFlash);
    setTimeout(() => setFlashCells([]), 500);
    setInfo(`Circuit #${st.circuitCount} closed! ${interior.length} interior cells captured. Boundary reset ✓`);
  }, []);

  const addCell = useCallback((q, r) => {
    const st = stateRef.current;
    const id = hexToId(q, r);
    if (st.path.length > 0 && st.path[st.path.length - 1] === id) return;
    const idx = st.path.indexOf(id);
    if (idx >= 0) {
      closeCircuit(idx);
      render();
      return;
    }
    st.path.push(id);
    render();
  }, [closeCircuit, render]);

  const canvasToHex = useCallback((clientX, clientY) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const px = (clientX - rect.left) * (canvas.width / rect.width) - canvas.width / 2;
    const py = (clientY - rect.top) * (canvas.height / rect.height) - canvas.height / 2;
    return pixelToHex(px, py);
  }, []);

  const onMouseDown = useCallback((e) => {
    isDrawing.current = true;
    const h = canvasToHex(e.clientX, e.clientY);
    if (h) addCell(h.q, h.r);
  }, [canvasToHex, addCell]);

  const onMouseMove = useCallback((e) => {
    if (!isDrawing.current) return;
    const h = canvasToHex(e.clientX, e.clientY);
    if (h) addCell(h.q, h.r);
  }, [canvasToHex, addCell]);

  const onMouseUp = useCallback(() => { isDrawing.current = false; }, []);

  const onTouchStart = useCallback((e) => {
    e.preventDefault();
    isDrawing.current = true;
    const t = e.touches[0];
    const h = canvasToHex(t.clientX, t.clientY);
    if (h) addCell(h.q, h.r);
  }, [canvasToHex, addCell]);

  const onTouchMove = useCallback((e) => {
    e.preventDefault();
    if (!isDrawing.current) return;
    const t = e.touches[0];
    const h = canvasToHex(t.clientX, t.clientY);
    if (h) addCell(h.q, h.r);
  }, [canvasToHex, addCell]);

  const resetAll = useCallback(() => {
    if (animRef.current) clearTimeout(animRef.current);
    stateRef.current = { path: [], scoredCells: {}, circuitCount: 0 };
    setFlashCells([]);
    render();
  }, [render]);

  // Run scenario animation
  const runPhase = useCallback((pts, idx, onDone) => {
    if (idx >= pts.length) { onDone && onDone(); return; }
    const { q, r } = pts[idx];
    addCell(q, r);
    animRef.current = setTimeout(() => runPhase(pts, idx + 1, onDone), 45);
  }, [addCell]);

  const setScenario = useCallback((name) => {
    resetAll();
    setActiveScenario(name);
    const sc = SCENARIOS[name];
    setInfo(sc.info);
    if (name === "manual") return;

    const runPhasesSeq = (phases, i = 0) => {
      if (i >= phases.length) return;
      const ph = phases[i];
      let q = ph.startQ, r = ph.startR;
      stateRef.current.path = [];
      // set start cell
      const id0 = hexToId(q, r);
      stateRef.current.path.push(id0);

      const pts = [];
      for (const [dq, dr] of ph.moves) {
        q += dq; r += dr;
        pts.push({ q, r });
      }
      runPhase(pts, 0, () => {
        animRef.current = setTimeout(() => runPhasesSeq(phases, i + 1), 600);
      });
    };

    if (sc.phases) {
      runPhasesSeq(sc.phases);
    } else if (sc.moves) {
      stateRef.current.path = [hexToId(0, 0)];
      const pts = [];
      let q = 0, r = 0;
      for (const [dq, dr] of sc.moves) { q += dq; r += dr; pts.push({ q, r }); }
      runPhase(pts, 0);
    }
  }, [resetAll, runPhase]);

  const scoreColors = [1, 2, 3, 4, 5, 6];

  return (
    <div style={{ fontFamily: "'DM Mono', 'Courier New', monospace", padding: "1rem 0", color: "#1a2733" }}>
      {/* Header */}
      <div style={{ marginBottom: 12 }}>
        <span style={{ fontSize: 11, letterSpacing: 2, textTransform: "uppercase", color: "#6b8099", fontWeight: 500 }}>
          H3 Territory Capture · Axial Hex Grid
        </span>
      </div>

      {/* Scenario buttons */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
        {Object.entries(SCENARIOS).map(([key, sc]) => (
          <button
            key={key}
            onClick={() => setScenario(key)}
            style={{
              fontSize: 12,
              padding: "5px 13px",
              borderRadius: 6,
              border: activeScenario === key ? "1.5px solid #2980b9" : "1px solid #cdd8e3",
              background: activeScenario === key ? "#ebf4fc" : "#f7f9fb",
              color: activeScenario === key ? "#1a5c8a" : "#3d5166",
              cursor: "pointer",
              fontFamily: "inherit",
              fontWeight: activeScenario === key ? 600 : 400,
              transition: "all 0.15s"
            }}
          >
            {sc.label}
          </button>
        ))}
        <button
          onClick={resetAll}
          style={{
            fontSize: 12, padding: "5px 13px", borderRadius: 6,
            border: "1px solid #e0b3b3", background: "#fdf0f0",
            color: "#a33", cursor: "pointer", fontFamily: "inherit", marginLeft: "auto"
          }}
        >
          ↺ Reset
        </button>
      </div>

      {/* Stats */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        {[
          ["Path cells", stats.path],
          ["Circuits closed", stats.circuits],
          ["Cells captured", stats.captured],
          ["Max score", stats.maxScore]
        ].map(([label, val]) => (
          <div key={label} style={{
            background: "#f0f4f8", borderRadius: 7, padding: "6px 14px",
            fontSize: 12, color: "#6b8099", border: "1px solid #dce5ed"
          }}>
            {label}: <strong style={{ color: "#1a2733" }}>{val}</strong>
          </div>
        ))}
      </div>

      {/* Canvas */}
      <canvas
        ref={canvasRef}
        style={{
          display: "block", borderRadius: 10, width: "100%",
          border: "1px solid #d0dde8", cursor: "crosshair",
          background: "#f8fafc", touchAction: "none"
        }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onMouseUp}
      />

      {/* Info bar */}
      <div style={{
        marginTop: 8, fontSize: 12, color: "#5a7a96", lineHeight: 1.6,
        padding: "8px 12px", background: "#f0f6fb", borderRadius: 7, border: "1px solid #d0e4f0"
      }}>
        {info}
      </div>

      {/* Legend */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 10, alignItems: "center", fontSize: 11, color: "#6b8099" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <div style={{ width: 14, height: 14, borderRadius: 3, background: "rgba(230,80,80,0.55)", border: "1.5px solid #c0392b" }} />
          Path start
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <div style={{ width: 14, height: 14, borderRadius: 3, background: "rgba(58,130,220,0.3)", border: "1px solid #2980b9" }} />
          Active path
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <div style={{ width: 14, height: 14, borderRadius: 3, background: "rgba(255,200,40,0.65)", border: "1.5px solid #d4a017" }} />
          Current position
        </div>
        <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
          {scoreColors.map(s => (
            <div key={s} style={{
              width: 14, height: 14, borderRadius: 3,
              background: scoreToFill(s), border: `1px solid ${scoreToStroke(s)}`
            }} title={`Score ${s}`} />
          ))}
          Score 1→6 (darker = higher)
        </div>
      </div>
    </div>
  );
}