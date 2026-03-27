import React, { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, Marker, Polygon, Polyline, TileLayer, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import * as h3 from "h3-js";

// ─── Constants ────────────────────────────────────────────────────────────────
const H3_RESOLUTION = 11;
const INTERPOLATION_STEP_METERS = 8;
const GPS_TIMEOUT_MS = 15000;

// Jitter filter — ignore GPS points closer than this or with too-high accuracy error
const MIN_DISTANCE_METERS = 3;
const MAX_ACCURACY_METERS = 25;

// Loop detection — segment intersection approach
const LOOP_SKIP_RECENT_SEGS = 4;   // skip last N segments when checking (avoids adjacent false positives)
const LOOP_MIN_ENCLOSED_CELLS = 8; // minimum H3 cells inside loop polygon to count
const LOOP_COOLDOWN_MS = 8000;     // don't fire two loop alerts within this window

// ─── Kalman filter for GPS smoothing ─────────────────────────────────────────
// A simple 1-D Kalman per axis. Tames GPS jitter without adding dependencies.
function makeKalman() {
  return { q: 3e-5, r: 0.01, x: null, p: 1 };
}
function kalmanStep(k, measurement) {
  if (k.x === null) { k.x = measurement; return measurement; }
  k.p += k.q;
  const gain = k.p / (k.p + k.r);
  k.x += gain * (measurement - k.x);
  k.p *= (1 - gain);
  return k.x;
}

// ─── Geo helpers ──────────────────────────────────────────────────────────────
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function metersBetween(a, b) {
  return haversineKm(a.lat, a.lng, b.lat, b.lng) * 1000;
}

// Convert lat/lng to flat-earth meters relative to an origin (for intersection math)
function toMeters(point, origin) {
  const latScale = 111320;
  const lngScale = 111320 * Math.cos((origin.lat * Math.PI) / 180);
  return {
    x: (point.lng - origin.lng) * lngScale,
    y: (point.lat - origin.lat) * latScale,
  };
}

function paceFromSpeedKmh(speedKmh) {
  if (!speedKmh || speedKmh < 0.5) return "--:--";
  const paceMin = 60 / speedKmh;
  const min = Math.floor(paceMin);
  const sec = Math.floor((paceMin - min) * 60);
  return `${min}:${String(sec).padStart(2, "0")}`;
}

function formatPace(minutesPerKm) {
  if (!Number.isFinite(minutesPerKm) || minutesPerKm <= 0) return "--:--";
  const min = Math.floor(minutesPerKm);
  const sec = Math.floor((minutesPerKm - min) * 60);
  return `${min}:${String(sec).padStart(2, "0")}`;
}

function interpolatePoints(a, b, stepMeters) {
  const dist = metersBetween(a, b);
  if (dist <= stepMeters) return [b];
  const count = Math.max(1, Math.floor(dist / stepMeters));
  const pts = [];
  for (let i = 1; i <= count; i++) {
    const t = i / count;
    pts.push({
      lat: a.lat + (b.lat - a.lat) * t,
      lng: a.lng + (b.lng - a.lng) * t,
      ts: a.ts + (b.ts - a.ts) * t,
      accuracy: Math.max(a.accuracy ?? 0, b.accuracy ?? 0),
    });
  }
  return pts;
}

function pathLengthMeters(samples) {
  let sum = 0;
  for (let i = 1; i < samples.length; i++) sum += metersBetween(samples[i - 1], samples[i]);
  return sum;
}

// ─── Segment intersection (CCW method) ───────────────────────────────────────
function ccw(ax, ay, bx, by, cx, cy) {
  return (cy - ay) * (bx - ax) > (by - ay) * (cx - ax);
}

function segmentsCross(ax, ay, bx, by, cx, cy, dx, dy) {
  return (
    ccw(ax, ay, cx, cy, dx, dy) !== ccw(bx, by, cx, cy, dx, dy) &&
    ccw(ax, ay, bx, by, cx, cy) !== ccw(ax, ay, bx, by, dx, dy)
  );
}

function intersectionPoint(ax, ay, bx, by, cx, cy, dx, dy) {
  const a1 = by - ay, b1 = ax - bx, c1 = a1 * ax + b1 * ay;
  const a2 = dy - cy, b2 = cx - dx, c2 = a2 * cx + b2 * cy;
  const det = a1 * b2 - a2 * b1;
  if (Math.abs(det) < 1e-10) return null;
  return { x: (c1 * b2 - c2 * b1) / det, y: (a1 * c2 - a2 * c1) / det };
}

// ─── Point-in-polygon (ray casting) ──────────────────────────────────────────
function pointInPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// Option B: hex counts if its center OR any corner overlaps the polygon
function hexOverlapsPolygon(hx, hy, hexRadiusM, poly) {
  if (pointInPolygon(hx, hy, poly)) return true;
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    const cx = hx + hexRadiusM * Math.cos(a);
    const cy = hy + hexRadiusM * Math.sin(a);
    if (pointInPolygon(cx, cy, poly)) return true;
  }
  return false;
}

// ─── Approximate H3 cell edge length in meters at a given resolution ─────────
// H3 res 11 ≈ 24m edge length → ~28m center-to-vertex radius
const H3_RES_RADIUS_M = {
  9: 174, 10: 66, 11: 25, 12: 9.5, 13: 3.6,
};

// ─── Shoelace area in m² ─────────────────────────────────────────────────────
function approxAreaM2(latlngPath) {
  if (!latlngPath || latlngPath.length < 3) return 0;
  const mid = latlngPath[Math.floor(latlngPath.length / 2)] || latlngPath[0];
  const latScale = 111320;
  const lngScale = 111320 * Math.cos((mid[0] * Math.PI) / 180);
  let area = 0;
  for (let i = 0; i < latlngPath.length; i++) {
    const j = (i + 1) % latlngPath.length;
    const x1 = latlngPath[i][1] * lngScale, y1 = latlngPath[i][0] * latScale;
    const x2 = latlngPath[j][1] * lngScale, y2 = latlngPath[j][0] * latScale;
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area / 2);
}

// ─── Map helper ───────────────────────────────────────────────────────────────
function MapFlyTo({ center }) {
  const map = useMap();
  useEffect(() => {
    if (center) map.panTo(center, { animate: true, duration: 0.5 });
  }, [center, map]);
  return null;
}

const runnerIcon = L.divIcon({
  className: "",
  html: '<div class="runner-dot"></div>',
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

// ─── Component ────────────────────────────────────────────────────────────────
export default function RunTraceH3React() {
  const mapRef = useRef(null);
  const watchIdRef = useRef(null);
  const runningRef = useRef(false);
  const pausedRef = useRef(false);
  const startedAtRef = useRef(null);
  const lastPosRef = useRef(null);           // last accepted (filtered) position
  const lastAlertTimeRef = useRef(0);
  const totalDistRef = useRef(0);
  const speedKmhRef = useRef(0);
  const splitStartDistRef = useRef(0);
  const splitStartTimeRef = useRef(null);

  // Kalman filters for lat & lng independently
  const kalmanLatRef = useRef(makeKalman());
  const kalmanLngRef = useRef(makeKalman());

  // GPS trail in world coords — used for route polyline & segment intersection
  // Each entry: { lat, lng, ts }
  const coordTrailRef = useRef([]);

  // Flat-meter segments for intersection checking
  // Each entry: { x1,y1, x2,y2, ptIdx } where ptIdx = index of start point in coordTrailRef
  const metersSegsRef = useRef([]);

  // Origin for flat-earth projection (first GPS point)
  const originRef = useRef(null);

  // H3 cells rasterized along the path (for hex scoring)
  const h3TrailRef = useRef([]); // [{ lat, lng, ts, cell }]

  const loopPolygonsRef = useRef([]);

  // ── React state (UI) ──
  const [mapReady, setMapReady] = useState(false);
  const [status, setStatus] = useState("idle");
  const [currentPos, setCurrentPos] = useState(null);
  const [route, setRoute] = useState([]);
  const [loopPolygons, setLoopPolygons] = useState([]);
  const [totalDistKm, setTotalDistKm] = useState(0);
  const [speedKmh, setSpeedKmh] = useState(0);
  const [paceStr, setPaceStr] = useState("--:--");
  const [splits, setSplits] = useState([]);
  const [alertVisible, setAlertVisible] = useState(false);
  const [alertText, setAlertText] = useState("");
  const [gpsWaiting, setGpsWaiting] = useState(true);
  const [gpsError, setGpsError] = useState("");

  const routeLineColor = "#c8f135";

  const initMapTile = useMemo(() => ({
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    maxZoom: 19,
  }), []);

  const center = currentPos ? [currentPos.lat, currentPos.lng] : [20.5937, 78.9629];

  function dismissAlert() { setAlertVisible(false); }

  function resetRun() {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    runningRef.current = false;
    pausedRef.current = false;
    startedAtRef.current = null;
    lastPosRef.current = null;
    lastAlertTimeRef.current = 0;
    totalDistRef.current = 0;
    speedKmhRef.current = 0;
    splitStartDistRef.current = 0;
    splitStartTimeRef.current = null;
    kalmanLatRef.current = makeKalman();
    kalmanLngRef.current = makeKalman();
    coordTrailRef.current = [];
    metersSegsRef.current = [];
    originRef.current = null;
    h3TrailRef.current = [];
    loopPolygonsRef.current = [];

    setRoute([]);
    setLoopPolygons([]);
    setTotalDistKm(0);
    setSpeedKmh(0);
    setPaceStr("--:--");
    setSplits([]);
    setCurrentPos((prev) => prev ? { ...prev } : prev);
    setStatus("idle");
    setAlertVisible(false);
  }

  function pauseRun() {
    runningRef.current = false;
    pausedRef.current = true;
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setStatus("paused");
  }

  function resumeRun() {
    if (!mapReady) return;
    runningRef.current = true;
    pausedRef.current = false;
    setStatus("running");
    startWatching();
  }

  function toggleRun() {
    if (!mapReady) return;
    if (!runningRef.current && !pausedRef.current) startRun();
    else if (runningRef.current) pauseRun();
    else if (pausedRef.current) resumeRun();
  }

  function startRun() {
    runningRef.current = true;
    pausedRef.current = false;
    startedAtRef.current = Date.now();
    splitStartTimeRef.current = Date.now();
    splitStartDistRef.current = totalDistRef.current;
    setStatus("running");
    startWatching();
  }

  function startWatching() {
    if (!navigator.geolocation) { setGpsError("GPS not available"); return; }
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    watchIdRef.current = navigator.geolocation.watchPosition(
      onPosition,
      (err) => { setGpsError(err?.message || "GPS error"); setGpsWaiting(false); },
      { enableHighAccuracy: true, maximumAge: 0, timeout: GPS_TIMEOUT_MS }
    );
  }

  function onPosition(pos) {
    const { latitude: rawLat, longitude: rawLng, speed, accuracy } = pos.coords;
    const ts = pos.timestamp;

    setGpsWaiting(false);
    setGpsError("");

    // ── 1. Accuracy gate — discard noisy fixes ──
    if (accuracy > MAX_ACCURACY_METERS) return;

    // ── 2. Kalman smooth ──
    const lat = kalmanStep(kalmanLatRef.current, rawLat);
    const lng = kalmanStep(kalmanLngRef.current, rawLng);
    const point = { lat, lng, ts, accuracy };

    // ── 3. Map init on very first fix ──
    if (!mapReady) {
      setCurrentPos(point);
      setMapReady(true);
      if (mapRef.current) mapRef.current.setView([lat, lng], 17);
    }

    // ── 4. Speed / pace ──
    const speedFromSensor = speed ? speed * 3.6 : 0;
    speedKmhRef.current = speedFromSensor;
    setSpeedKmh(speedKmhRef.current);
    setPaceStr(paceFromSpeedKmh(speedKmhRef.current));
    setCurrentPos(point);

    if (!runningRef.current) return; // don't record if paused / idle

    // ── 5. Minimum distance gate — discard GPS jitter ──
    const prev = lastPosRef.current;
    if (prev && metersBetween(prev, point) < MIN_DISTANCE_METERS) return;

    // ── 6. Accept point ──
    lastPosRef.current = point;

    // Distance accounting
    if (prev) {
      const dKm = haversineKm(prev.lat, prev.lng, lat, lng);
      totalDistRef.current += dKm;
      setTotalDistKm(totalDistRef.current);

      const kmCrossed = Math.floor(totalDistRef.current);
      const lastSplitKm = Math.floor(splitStartDistRef.current);
      if (kmCrossed > lastSplitKm) {
        const splitTimeMin = (ts - splitStartTimeRef.current) / 1000 / 60;
        const paceMin = splitTimeMin / Math.max(1, kmCrossed - lastSplitKm);
        setSplits((s) => [...s, { km: kmCrossed, pace: paceMin }]);
        splitStartDistRef.current = totalDistRef.current;
        splitStartTimeRef.current = ts;
      }
    }

    // Route polyline
    setRoute((r) => [...r, [lat, lng]]);
    coordTrailRef.current.push(point);

    // Set projection origin on first accepted point
    if (!originRef.current) originRef.current = point;

    // ── 7. Build flat-meter segment & check for loop ──
    const trail = coordTrailRef.current;
    if (trail.length >= 2) {
      const p1 = trail[trail.length - 2];
      const p2 = trail[trail.length - 1];
      const m1 = toMeters(p1, originRef.current);
      const m2 = toMeters(p2, originRef.current);
      metersSegsRef.current.push({ x1: m1.x, y1: m1.y, x2: m2.x, y2: m2.y });
      checkLoopIntersection();
    }

    // ── 8. H3 densification (for hex cell rasterisation) ──
    if (prev) {
      const samples = interpolatePoints(prev, point, INTERPOLATION_STEP_METERS);
      for (const sample of samples) appendH3Sample(sample);
    } else {
      appendH3Sample(point);
    }

    if (mapRef.current) mapRef.current.panTo([lat, lng], { animate: true, duration: 0.5 });
  }

  // ── H3 rasterisation (unchanged from original) ───────────────────────────
  function appendH3Sample(sample) {
    const cell = h3.latLngToCell(sample.lat, sample.lng, H3_RESOLUTION);
    const samples = h3TrailRef.current;
    const last = samples[samples.length - 1];
    if (!last || last.cell !== cell) {
      samples.push({ ...sample, cell });
    } else {
      samples[samples.length - 1] = { ...sample, cell };
    }
  }

  // ── Core loop detection: segment intersection ────────────────────────────
  function checkLoopIntersection() {
    const segs = metersSegsRef.current;
    const trail = coordTrailRef.current;
    const n = segs.length;
    if (n < 3) return;

    const ns = segs[n - 1]; // newest segment

    // Check against all segments except the most recent LOOP_SKIP_RECENT_SEGS
    for (let i = 0; i <= n - 2 - LOOP_SKIP_RECENT_SEGS; i++) {
      const s = segs[i];
      if (!segmentsCross(ns.x1, ns.y1, ns.x2, ns.y2, s.x1, s.y1, s.x2, s.y2)) continue;

      const ip = intersectionPoint(ns.x1, ns.y1, ns.x2, ns.y2, s.x1, s.y1, s.x2, s.y2);
      if (!ip) continue;

      // ── Build loop polygon in flat-meter space ──
      // segs[i] starts at trail[i], segs[n-1] ends at trail[n]
      // loop = ip → trail[i+1] → … → trail[n-1] → trail[n] → ip
      const loopMetersPoints = [
        ip,
        ...trail.slice(i + 1).map((p) => toMeters(p, originRef.current)),
        ip,
      ];

      // ── Count H3 cells inside the loop (Option B: center OR corner overlap) ──
      const hexRadiusM = H3_RES_RADIUS_M[H3_RESOLUTION] ?? 25;
      const h3Samples = h3TrailRef.current;
      const enclosedCells = new Set();

      // Build a unique set of cells to test
      const uniqueCellsToTest = new Map();
      h3Samples.forEach((s) => {
        if (!uniqueCellsToTest.has(s.cell)) {
          uniqueCellsToTest.set(s.cell, toMeters(s, originRef.current));
        }
      });

      uniqueCellsToTest.forEach((mpt, cell) => {
        if (hexOverlapsPolygon(mpt.x, mpt.y, hexRadiusM, loopMetersPoints)) {
          enclosedCells.add(cell);
        }
      });

      if (enclosedCells.size < LOOP_MIN_ENCLOSED_CELLS) continue;

      // ── Cooldown check ──
      const now = Date.now();
      if (now - lastAlertTimeRef.current < LOOP_COOLDOWN_MS) continue;
      lastAlertTimeRef.current = now;

      // ── Build lat/lng polygon for Leaflet rendering ──
      const origin = originRef.current;
      const latScale = 111320;
      const lngScale = 111320 * Math.cos((origin.lat * Math.PI) / 180);
      const loopLatLng = loopMetersPoints.map((mp) => [
        origin.lat + mp.y / latScale,
        origin.lng + mp.x / lngScale,
      ]);

      const areaM2 = approxAreaM2(loopLatLng);
      const loopMeters = pathLengthMeters(trail.slice(i + 1));
      const areaStr = areaM2 < 10000
        ? `${Math.round(areaM2)} m²`
        : `${(areaM2 / 1e6).toFixed(3)} km²`;
      const distStr = loopMeters < 1000
        ? `${Math.round(loopMeters)}m loop`
        : `${(loopMeters / 1000).toFixed(2)}km loop`;
      const score = Math.floor(Math.sqrt(enclosedCells.size));

      loopPolygonsRef.current = [...loopPolygonsRef.current, loopLatLng];
      setLoopPolygons([...loopPolygonsRef.current]);
      setAlertText(`${distStr} · ${areaStr} · ${enclosedCells.size} cells · score +${score}`);
      setAlertVisible(true);
      window.setTimeout(() => setAlertVisible(false), 6000);

      break; // one loop detection per GPS ping is enough
    }
  }

  // ── Splits rendering (unchanged) ─────────────────────────────────────────
  function renderSplits() {
    if (!splits.length) return <div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--mono)" }}>— no splits yet —</div>;
    const bestPace = Math.min(...splits.map((s) => s.pace));
    return splits.slice().reverse().map((s) => {
      const barW = Math.min(100, (bestPace / s.pace) * 100);
      return (
        <div className="split-row" key={`${s.km}-${s.pace}`}>
          <span className="split-km">KM {s.km}</span>
          <div className="split-bar-wrap">
            <div className="split-bar" style={{ width: `${barW}%` }} />
          </div>
          <span className="split-pace">{formatPace(s.pace)}/km</span>
        </div>
      );
    });
  }

  // ── Initial GPS fix (unchanged) ──────────────────────────────────────────
  useEffect(() => {
    if (!navigator.geolocation) {
      setGpsError("GPS not available");
      setGpsWaiting(false);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lng, accuracy } = pos.coords;
        const point = { lat, lng, ts: pos.timestamp, accuracy: accuracy ?? 0 };
        // Prime the Kalman filters with the first fix
        kalmanStep(kalmanLatRef.current, lat);
        kalmanStep(kalmanLngRef.current, lng);
        setCurrentPos(point);
        setMapReady(true);
        setGpsWaiting(false);
        if (mapRef.current) mapRef.current.setView([lat, lng], 17);
      },
      (err) => { setGpsError(err?.message || "GPS error"); setGpsWaiting(false); },
      { enableHighAccuracy: true, timeout: GPS_TIMEOUT_MS, maximumAge: 0 }
    );
    return () => {
      if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
    };
  }, []);

  const buttonLabel = !runningRef.current && !pausedRef.current ? "START RUN" : runningRef.current ? "PAUSE" : "RESUME";
  const buttonClass = runningRef.current ? "running" : pausedRef.current ? "paused" : "";

  // ── Render (identical to original) ───────────────────────────────────────
  return (
    <div id="app">
      <style>{`
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        :root {
          --bg: #0a0a0a; --surface: #141414; --surface2: #1e1e1e;
          --border: #2a2a2a; --accent: #c8f135; --accent2: #ff6b35;
          --text: #f0f0f0; --muted: #666;
          --mono: 'Space Mono', monospace; --sans: 'DM Sans', sans-serif;
        }
        html, body, #root { height: 100%; width: 100%; }
        body { overflow: hidden; background: var(--bg); color: var(--text); font-family: var(--sans); -webkit-font-smoothing: antialiased; }
        #app { display: flex; flex-direction: column; height: 100dvh; width: 100%; position: relative; }
        #mapWrap { flex: 1; width: 100%; position: relative; z-index: 1; }
        .leaflet-container { background: #111 !important; height: 100%; width: 100%; }
        .leaflet-tile-pane { filter: invert(1) hue-rotate(180deg) brightness(0.85) saturate(0.7); }
        #hud { position: absolute; top: 16px; left: 16px; right: 16px; z-index: 1000; display: flex; justify-content: space-between; align-items: flex-start; pointer-events: none; }
        #logo { font-family: var(--mono); font-size: 13px; font-weight: 700; letter-spacing: 0.15em; color: var(--accent); background: rgba(10,10,10,0.85); padding: 6px 10px; border-radius: 6px; border: 1px solid rgba(200,241,53,0.2); backdrop-filter: blur(8px); }
        #status-pill { font-family: var(--mono); font-size: 11px; font-weight: 700; letter-spacing: 0.1em; padding: 6px 12px; border-radius: 20px; background: rgba(10,10,10,0.85); border: 1px solid var(--border); backdrop-filter: blur(8px); display: flex; align-items: center; gap: 6px; transition: all 0.3s; }
        #status-pill.idle { color: var(--muted); border-color: var(--border); }
        #status-pill.running { color: var(--accent); border-color: rgba(200,241,53,0.3); }
        #status-pill.paused { color: var(--accent2); border-color: rgba(255,107,53,0.3); }
        .pulse { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
        .pulse.active { animation: pulse 1.2s ease-in-out infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.7); } }
        #panel { background: var(--surface); border-top: 1px solid var(--border); z-index: 1000; padding: 16px 16px 24px; }
        #stats { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-bottom: 14px; }
        .stat { background: var(--surface2); border-radius: 10px; padding: 10px 10px 8px; border: 1px solid var(--border); position: relative; overflow: hidden; }
        .stat::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px; background: var(--accent); opacity: 0; transition: opacity 0.3s; }
        .stat.active::before { opacity: 1; }
        .stat-label { font-size: 9px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); font-family: var(--mono); margin-bottom: 4px; }
        .stat-value { font-family: var(--mono); font-size: 22px; font-weight: 700; color: var(--text); line-height: 1; }
        .stat-unit { font-size: 10px; color: var(--muted); font-family: var(--mono); margin-top: 2px; }
        #splits-wrap { margin-bottom: 14px; max-height: 72px; overflow-y: auto; }
        #splits-wrap::-webkit-scrollbar { display: none; }
        #splits-header { font-family: var(--mono); font-size: 9px; letter-spacing: 0.12em; color: var(--muted); text-transform: uppercase; margin-bottom: 6px; }
        #splits-list { display: flex; flex-direction: column; gap: 4px; }
        .split-row { display: flex; align-items: center; gap: 8px; animation: slideIn 0.3s ease; }
        @keyframes slideIn { from { opacity: 0; transform: translateX(-8px); } to { opacity: 1; transform: translateX(0); } }
        .split-km { font-family: var(--mono); font-size: 10px; color: var(--muted); width: 36px; }
        .split-bar-wrap { flex: 1; height: 4px; background: var(--surface2); border-radius: 2px; overflow: hidden; }
        .split-bar { height: 100%; background: var(--accent); border-radius: 2px; transition: width 0.5s ease; }
        .split-pace { font-family: var(--mono); font-size: 11px; color: var(--text); width: 52px; text-align: right; }
        #controls { display: flex; gap: 10px; }
        #btn-start { flex: 1; height: 52px; border-radius: 12px; border: none; font-family: var(--mono); font-size: 13px; font-weight: 700; letter-spacing: 0.08em; cursor: pointer; transition: all 0.2s; background: var(--accent); color: #0a0a0a; }
        #btn-start:active { transform: scale(0.97); }
        #btn-start.running { background: var(--accent2); color: #fff; }
        #btn-start.paused { background: var(--surface2); color: var(--accent); border: 1px solid rgba(200,241,53,0.3); }
        #btn-reset { width: 52px; height: 52px; border-radius: 12px; border: 1px solid var(--border); background: var(--surface2); color: var(--muted); font-size: 18px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.2s; }
        #btn-reset:active { transform: scale(0.95); }
        #circuit-alert { position: absolute; top: 70px; left: 16px; right: 16px; z-index: 2000; background: rgba(10,10,10,0.95); border: 1px solid var(--accent); border-radius: 12px; padding: 14px 16px; display: none; backdrop-filter: blur(12px); animation: alertIn 0.4s cubic-bezier(0.34, 1.56, 0.64, 1); }
        @keyframes alertIn { from { opacity: 0; transform: translateY(-12px) scale(0.96); } to { opacity: 1; transform: translateY(0) scale(1); } }
        #circuit-alert.show { display: flex; align-items: center; gap: 12px; }
        .alert-icon { width: 36px; height: 36px; border-radius: 50%; background: rgba(200,241,53,0.15); border: 1px solid rgba(200,241,53,0.4); display: flex; align-items: center; justify-content: center; font-size: 16px; flex-shrink: 0; }
        .alert-body { flex: 1; }
        .alert-title { font-family: var(--mono); font-size: 12px; font-weight: 700; color: var(--accent); letter-spacing: 0.08em; margin-bottom: 2px; }
        .alert-sub { font-size: 11px; color: var(--muted); }
        .alert-close { background: none; border: none; color: var(--muted); font-size: 16px; cursor: pointer; padding: 4px; line-height: 1; }
        #gps-waiting { position: absolute; inset: 0; z-index: 3000; background: rgba(10,10,10,0.92); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; backdrop-filter: blur(4px); }
        #gps-waiting.hidden { display: none; }
        .gps-spinner { width: 48px; height: 48px; border-radius: 50%; border: 2px solid var(--border); border-top-color: var(--accent); animation: spin 0.9s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .gps-text { font-family: var(--mono); font-size: 12px; color: var(--muted); letter-spacing: 0.1em; text-align: center; padding: 0 24px; }
        .runner-dot { width: 16px; height: 16px; border-radius: 50%; background: var(--accent); border: 3px solid #0a0a0a; box-shadow: 0 0 0 3px rgba(200,241,53,0.3); }
      `}</style>

      {gpsWaiting && (
        <div id="gps-waiting">
          <div className="gps-spinner" />
          <div className="gps-text">ACQUIRING GPS...</div>
        </div>
      )}

      <div id="mapWrap">
        <MapContainer
          center={center}
          zoom={17}
          zoomControl={false}
          attributionControl={false}
          whenCreated={(mapInstance) => { mapRef.current = mapInstance; }}
        >
          <TileLayer {...initMapTile} />
          {currentPos && <MapFlyTo center={[currentPos.lat, currentPos.lng]} />}
          {route.length > 0 && (
            <Polyline
              positions={route}
              pathOptions={{ color: routeLineColor, weight: 3.5, opacity: 0.9, lineJoin: "round", lineCap: "round" }}
            />
          )}
          {loopPolygons.map((poly, idx) => (
            <Polygon
              key={`${idx}-${poly.length}`}
              positions={poly}
              pathOptions={{ color: routeLineColor, fillColor: routeLineColor, fillOpacity: 0.08, weight: 1.5, dashArray: "4 4" }}
            />
          ))}
          {currentPos && <Marker position={[currentPos.lat, currentPos.lng]} icon={runnerIcon} />}
        </MapContainer>
      </div>

      <div id="hud">
        <div id="logo">RUNTRACE</div>
        <div id="status-pill" className={status}>
          <div className={`pulse ${status === "running" ? "active" : ""}`} />
          <span id="status-text">{status.toUpperCase()}</span>
        </div>
      </div>

      <div id="circuit-alert" className={alertVisible ? "show" : ""}>
        <div className="alert-icon">⬡</div>
        <div className="alert-body">
          <div className="alert-title">CIRCUIT DETECTED</div>
          <div className="alert-sub">{alertText}</div>
        </div>
        <button className="alert-close" onClick={dismissAlert}>✕</button>
      </div>

      <div id="panel">
        <div id="stats">
          <div className="stat active">
            <div className="stat-label">Distance</div>
            <div className="stat-value">{totalDistKm.toFixed(2)}</div>
            <div className="stat-unit">km</div>
          </div>
          <div className="stat active">
            <div className="stat-label">Pace</div>
            <div className="stat-value">{paceStr}</div>
            <div className="stat-unit">min/km</div>
          </div>
          <div className="stat active">
            <div className="stat-label">Speed</div>
            <div className="stat-value">{speedKmh.toFixed(1)}</div>
            <div className="stat-unit">km/h</div>
          </div>
        </div>

        <div id="splits-wrap">
          <div id="splits-header">KM SPLITS</div>
          <div id="splits-list">{renderSplits()}</div>
        </div>

        <div id="controls">
          <button id="btn-start" className={buttonClass} onClick={toggleRun}>{buttonLabel}</button>
          <button id="btn-reset" onClick={resetRun} title="Reset">↺</button>
        </div>

        {gpsError && (
          <div style={{ marginTop: 10, fontFamily: "var(--mono)", fontSize: 11, color: "#ff6b35" }}>
            {gpsError}
          </div>
        )}
      </div>
    </div>
  );
}