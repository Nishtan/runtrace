import React, { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, Marker, Polygon, Polyline, TileLayer, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import * as h3 from "h3-js";

const H3_RESOLUTION = 11;
const INTERPOLATION_STEP_METERS = 8;
const LOOP_CLOSE_THRESHOLD_METERS = 30;
const LOOP_MIN_PATH_METERS = 180;
const LOOP_MIN_UNIQUE_CELLS = 8;
const LOOP_MIN_CELL_GAP = 10;
const GPS_TIMEOUT_MS = 15000;

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

function uniqueCellCount(samples) {
  return new Set(samples.map((s) => s.cell)).size;
}

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

export default function RunTraceH3React() {
  const mapRef = useRef(null);
  const watchIdRef = useRef(null);
  const runningRef = useRef(false);
  const pausedRef = useRef(false);
  const startedAtRef = useRef(null);
  const lastPosRef = useRef(null);
  const lastAlertTimeRef = useRef(0);
  const lastLoopSignatureRef = useRef("");
  const totalDistRef = useRef(0);
  const speedKmhRef = useRef(0);
  const splitStartDistRef = useRef(0);
  const splitStartTimeRef = useRef(null);
  const coordTrailRef = useRef([]);
  const h3TrailRef = useRef([]); // [{lat,lng,ts,cell}]
  const loopPolygonsRef = useRef([]);

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
  const [alertText, setAlertText] = useState("Loop closed — area being computed");
  const [gpsWaiting, setGpsWaiting] = useState(true);
  const [gpsError, setGpsError] = useState("");

  const routeLineColor = "#c8f135";

  const initMapTile = useMemo(() => ({
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    maxZoom: 19,
  }), []);

  const center = currentPos ? [currentPos.lat, currentPos.lng] : [20.5937, 78.9629];

  function setStatusUI(next) {
    setStatus(next);
  }

  function dismissAlert() {
    setAlertVisible(false);
  }

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
    lastLoopSignatureRef.current = "";
    totalDistRef.current = 0;
    speedKmhRef.current = 0;
    splitStartDistRef.current = 0;
    splitStartTimeRef.current = null;
    coordTrailRef.current = [];
    h3TrailRef.current = [];
    loopPolygonsRef.current = [];

    setRoute([]);
    setLoopPolygons([]);
    setTotalDistKm(0);
    setSpeedKmh(0);
    setPaceStr("--:--");
    setSplits([]);
    setCurrentPos((prev) => prev ? { ...prev } : prev);
    setStatusUI("idle");
    setAlertVisible(false);
  }

  function pauseRun() {
    runningRef.current = false;
    pausedRef.current = true;
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setStatusUI("paused");
  }

  function resumeRun() {
    if (!mapReady) return;
    runningRef.current = true;
    pausedRef.current = false;
    setStatusUI("running");
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
    setStatusUI("running");
    startWatching();
  }

  function startWatching() {
    if (!navigator.geolocation) {
      setGpsError("GPS not available");
      return;
    }

    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }

    watchIdRef.current = navigator.geolocation.watchPosition(
      onPosition,
      (err) => {
        setGpsError(err?.message || "GPS error");
        setGpsWaiting(false);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: GPS_TIMEOUT_MS,
      }
    );
  }

  function onPosition(pos) {
    const { latitude: lat, longitude: lng, speed, accuracy } = pos.coords;
    const ts = pos.timestamp;
    const point = { lat, lng, ts, accuracy: accuracy ?? 0 };

    setGpsWaiting(false);
    setGpsError("");

    if (!mapReady) {
      setCurrentPos(point);
      setMapReady(true);
      if (mapRef.current) mapRef.current.setView([lat, lng], 17);
    }

    // Current speed from the device, with a fallback to distance/time if needed.
    const speedFromSensor = speed ? speed * 3.6 : 0;
    speedKmhRef.current = speedFromSensor;
    setSpeedKmh(speedKmhRef.current);
    setPaceStr(paceFromSpeedKmh(speedKmhRef.current));

    if (lastPosRef.current) {
      const dKm = haversineKm(lastPosRef.current.lat, lastPosRef.current.lng, lat, lng);
      totalDistRef.current += dKm;
      setTotalDistKm(totalDistRef.current);

      const kmCrossed = Math.floor(totalDistRef.current);
      const lastSplitKm = Math.floor(splitStartDistRef.current);
      if (kmCrossed > lastSplitKm) {
        const splitTimeMin = (ts - splitStartTimeRef.current) / 1000 / 60;
        const paceMin = splitTimeMin / Math.max(1, kmCrossed - lastSplitKm);
        setSplits((prev) => [
          ...prev,
          { km: kmCrossed, pace: paceMin },
        ]);
        splitStartDistRef.current = totalDistRef.current;
        splitStartTimeRef.current = ts;
      }
    }

    const prev = lastPosRef.current;
    lastPosRef.current = point;
    setCurrentPos(point);

    const latlng = [lat, lng];
    setRoute((prevRoute) => [...prevRoute, latlng]);
    coordTrailRef.current.push(point);

    // H3 densification: break long GPS jumps into smaller pieces, then convert each to an H3 cell.
    if (prev) {
      const samples = interpolatePoints(prev, point, INTERPOLATION_STEP_METERS);
      for (const sample of samples) {
        appendH3Sample(sample);
      }
    } else {
      appendH3Sample(point);
    }

    // Keep map centered on the runner.
    if (mapRef.current) mapRef.current.panTo(latlng, { animate: true, duration: 0.5 });

    // The UI is a little nicer if the stats move even with sparse GPS.
    setSpeedKmh(speedKmhRef.current);
    setPaceStr(paceFromSpeedKmh(speedKmhRef.current));
  }

  function appendH3Sample(sample) {
    const cell = h3.latLngToCell([sample.lat, sample.lng], H3_RESOLUTION);
    const samples = h3TrailRef.current;
    const last = samples[samples.length - 1];

    if (!last || last.cell !== cell) {
      samples.push({ ...sample, cell });
    } else {
      // Update the timestamp/position of the most recent sample if we are still in the same cell.
      samples[samples.length - 1] = { ...sample, cell };
    }

    maybeDetectLoop();
  }

  function maybeDetectLoop() {
    const samples = h3TrailRef.current;
    if (samples.length < LOOP_MIN_CELL_GAP) return;

    const currentIndex = samples.length - 1;
    const current = samples[currentIndex];

    // Find the most recent earlier occurrence of the same H3 cell.
    let previousIndex = -1;
    for (let i = currentIndex - 1; i >= 0; i--) {
      if (samples[i].cell === current.cell) {
        previousIndex = i;
        break;
      }
    }
    if (previousIndex < 0) return;
    if (currentIndex - previousIndex < LOOP_MIN_CELL_GAP) return;

    const loopSamples = samples.slice(previousIndex, currentIndex + 1);
    const uniqueCells = uniqueCellCount(loopSamples);
    if (uniqueCells < LOOP_MIN_UNIQUE_CELLS) return;

    const start = loopSamples[0];
    const end = loopSamples[loopSamples.length - 1];
    const closureMeters = metersBetween(start, end);
    if (closureMeters > LOOP_CLOSE_THRESHOLD_METERS) return;

    const loopMeters = pathLengthMeters(loopSamples);
    if (loopMeters < LOOP_MIN_PATH_METERS) return;

    const signature = `${previousIndex}:${currentIndex}:${start.cell}`;
    if (signature === lastLoopSignatureRef.current) return;

    const now = Date.now();
    if (now - lastAlertTimeRef.current < 10000) return;

    lastAlertTimeRef.current = now;
    lastLoopSignatureRef.current = signature;

    const loopPath = loopSamples.map((s) => [s.lat, s.lng]);
    const areaM2 = approxAreaM2(loopPath);

    loopPolygonsRef.current = [...loopPolygonsRef.current, loopPath];
    setLoopPolygons([...loopPolygonsRef.current]);

    const areaStr = areaM2 < 10000 ? `${Math.round(areaM2)} m²` : `${(areaM2 / 1e6).toFixed(3)} km²`;
    const distStr = loopMeters < 1000 ? `${Math.round(loopMeters)}m loop` : `${(loopMeters / 1000).toFixed(2)}km loop`;
    setAlertText(`${distStr} · Area ≈ ${areaStr}`);
    setAlertVisible(true);

    window.setTimeout(() => setAlertVisible(false), 6000);
  }

  function approxAreaM2(latlngPath) {
    if (!latlngPath || latlngPath.length < 3) return 0;

    // Approximate projected shoelace area on local meters.
    const mid = latlngPath[Math.floor(latlngPath.length / 2)] || latlngPath[0];
    const latScale = 111320;
    const lngScale = 111320 * Math.cos((mid[0] * Math.PI) / 180);

    let area = 0;
    for (let i = 0; i < latlngPath.length; i++) {
      const j = (i + 1) % latlngPath.length;
      const x1 = latlngPath[i][1] * lngScale;
      const y1 = latlngPath[i][0] * latScale;
      const x2 = latlngPath[j][1] * lngScale;
      const y2 = latlngPath[j][0] * latScale;
      area += x1 * y2 - x2 * y1;
    }
    return Math.abs(area / 2);
  }

  function renderSplits() {
    if (!splits.length) return <div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--mono)" }}>— no splits yet —</div>;

    const bestPace = Math.min(...splits.map((s) => s.pace));
    return splits
      .slice()
      .reverse()
      .map((s) => {
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
        setCurrentPos(point);
        setMapReady(true);
        setGpsWaiting(false);
        if (mapRef.current) mapRef.current.setView([lat, lng], 17);
      },
      (err) => {
        setGpsError(err?.message || "GPS error");
        setGpsWaiting(false);
      },
      {
        enableHighAccuracy: true,
        timeout: GPS_TIMEOUT_MS,
        maximumAge: 1000,
      }
    );

    return () => {
      if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
    };
  }, []);

  const buttonLabel = !runningRef.current && !pausedRef.current ? "START RUN" : runningRef.current ? "PAUSE" : "RESUME";
  const buttonClass = runningRef.current ? "running" : pausedRef.current ? "paused" : "";

  return (
    <div id="app">
      <style>{`
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        :root {
          --bg: #0a0a0a;
          --surface: #141414;
          --surface2: #1e1e1e;
          --border: #2a2a2a;
          --accent: #c8f135;
          --accent2: #ff6b35;
          --text: #f0f0f0;
          --muted: #666;
          --mono: 'Space Mono', monospace;
          --sans: 'DM Sans', sans-serif;
        }

        html, body, #root { height: 100%; width: 100%; }
        body {
          overflow: hidden;
          background: var(--bg);
          color: var(--text);
          font-family: var(--sans);
          -webkit-font-smoothing: antialiased;
        }

        #app {
          display: flex;
          flex-direction: column;
          height: 100dvh;
          width: 100%;
          position: relative;
        }

        #mapWrap {
          flex: 1;
          width: 100%;
          position: relative;
          z-index: 1;
        }

        .leaflet-container {
          background: #111 !important;
          height: 100%;
          width: 100%;
        }

        .leaflet-tile-pane {
          filter: invert(1) hue-rotate(180deg) brightness(0.85) saturate(0.7);
        }

        #hud {
          position: absolute;
          top: 16px;
          left: 16px;
          right: 16px;
          z-index: 1000;
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          pointer-events: none;
        }

        #logo {
          font-family: var(--mono);
          font-size: 13px;
          font-weight: 700;
          letter-spacing: 0.15em;
          color: var(--accent);
          background: rgba(10,10,10,0.85);
          padding: 6px 10px;
          border-radius: 6px;
          border: 1px solid rgba(200,241,53,0.2);
          backdrop-filter: blur(8px);
        }

        #status-pill {
          font-family: var(--mono);
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.1em;
          padding: 6px 12px;
          border-radius: 20px;
          background: rgba(10,10,10,0.85);
          border: 1px solid var(--border);
          backdrop-filter: blur(8px);
          display: flex;
          align-items: center;
          gap: 6px;
          transition: all 0.3s;
        }

        #status-pill.idle { color: var(--muted); border-color: var(--border); }
        #status-pill.running { color: var(--accent); border-color: rgba(200,241,53,0.3); }
        #status-pill.paused { color: var(--accent2); border-color: rgba(255,107,53,0.3); }

        .pulse {
          width: 7px; height: 7px;
          border-radius: 50%;
          background: currentColor;
        }
        .pulse.active { animation: pulse 1.2s ease-in-out infinite; }
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(0.7); }
        }

        #panel {
          background: var(--surface);
          border-top: 1px solid var(--border);
          z-index: 1000;
          padding: 16px 16px 24px;
        }

        #stats {
          display: grid;
          grid-template-columns: 1fr 1fr 1fr;
          gap: 8px;
          margin-bottom: 14px;
        }

        .stat {
          background: var(--surface2);
          border-radius: 10px;
          padding: 10px 10px 8px;
          border: 1px solid var(--border);
          position: relative;
          overflow: hidden;
        }

        .stat::before {
          content: '';
          position: absolute;
          top: 0; left: 0; right: 0;
          height: 2px;
          background: var(--accent);
          opacity: 0;
          transition: opacity 0.3s;
        }

        .stat.active::before { opacity: 1; }

        .stat-label {
          font-size: 9px;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: var(--muted);
          font-family: var(--mono);
          margin-bottom: 4px;
        }

        .stat-value {
          font-family: var(--mono);
          font-size: 22px;
          font-weight: 700;
          color: var(--text);
          line-height: 1;
        }

        .stat-unit {
          font-size: 10px;
          color: var(--muted);
          font-family: var(--mono);
          margin-top: 2px;
        }

        #splits-wrap {
          margin-bottom: 14px;
          max-height: 72px;
          overflow-y: auto;
        }

        #splits-wrap::-webkit-scrollbar { display: none; }

        #splits-header {
          font-family: var(--mono);
          font-size: 9px;
          letter-spacing: 0.12em;
          color: var(--muted);
          text-transform: uppercase;
          margin-bottom: 6px;
        }

        #splits-list {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .split-row {
          display: flex;
          align-items: center;
          gap: 8px;
          animation: slideIn 0.3s ease;
        }

        @keyframes slideIn {
          from { opacity: 0; transform: translateX(-8px); }
          to { opacity: 1; transform: translateX(0); }
        }

        .split-km {
          font-family: var(--mono);
          font-size: 10px;
          color: var(--muted);
          width: 36px;
        }

        .split-bar-wrap {
          flex: 1;
          height: 4px;
          background: var(--surface2);
          border-radius: 2px;
          overflow: hidden;
        }

        .split-bar {
          height: 100%;
          background: var(--accent);
          border-radius: 2px;
          transition: width 0.5s ease;
        }

        .split-pace {
          font-family: var(--mono);
          font-size: 11px;
          color: var(--text);
          width: 52px;
          text-align: right;
        }

        #controls {
          display: flex;
          gap: 10px;
        }

        #btn-start {
          flex: 1;
          height: 52px;
          border-radius: 12px;
          border: none;
          font-family: var(--mono);
          font-size: 13px;
          font-weight: 700;
          letter-spacing: 0.08em;
          cursor: pointer;
          transition: all 0.2s;
          background: var(--accent);
          color: #0a0a0a;
        }

        #btn-start:active { transform: scale(0.97); }
        #btn-start.running { background: var(--accent2); color: #fff; }
        #btn-start.paused { background: var(--surface2); color: var(--accent); border: 1px solid rgba(200,241,53,0.3); }

        #btn-reset {
          width: 52px;
          height: 52px;
          border-radius: 12px;
          border: 1px solid var(--border);
          background: var(--surface2);
          color: var(--muted);
          font-size: 18px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.2s;
        }

        #btn-reset:active { transform: scale(0.95); }

        #circuit-alert {
          position: absolute;
          top: 70px;
          left: 16px;
          right: 16px;
          z-index: 2000;
          background: rgba(10,10,10,0.95);
          border: 1px solid var(--accent);
          border-radius: 12px;
          padding: 14px 16px;
          display: none;
          backdrop-filter: blur(12px);
          animation: alertIn 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
        }

        @keyframes alertIn {
          from { opacity: 0; transform: translateY(-12px) scale(0.96); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }

        #circuit-alert.show { display: flex; align-items: center; gap: 12px; }

        .alert-icon {
          width: 36px; height: 36px;
          border-radius: 50%;
          background: rgba(200,241,53,0.15);
          border: 1px solid rgba(200,241,53,0.4);
          display: flex; align-items: center; justify-content: center;
          font-size: 16px;
          flex-shrink: 0;
        }

        .alert-body { flex: 1; }
        .alert-title {
          font-family: var(--mono);
          font-size: 12px;
          font-weight: 700;
          color: var(--accent);
          letter-spacing: 0.08em;
          margin-bottom: 2px;
        }

        .alert-sub {
          font-size: 11px;
          color: var(--muted);
        }

        .alert-close {
          background: none;
          border: none;
          color: var(--muted);
          font-size: 16px;
          cursor: pointer;
          padding: 4px;
          line-height: 1;
        }

        #gps-waiting {
          position: absolute;
          inset: 0;
          z-index: 3000;
          background: rgba(10,10,10,0.92);
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 16px;
          backdrop-filter: blur(4px);
        }

        #gps-waiting.hidden { display: none; }

        .gps-spinner {
          width: 48px; height: 48px;
          border-radius: 50%;
          border: 2px solid var(--border);
          border-top-color: var(--accent);
          animation: spin 0.9s linear infinite;
        }

        @keyframes spin { to { transform: rotate(360deg); } }

        .gps-text {
          font-family: var(--mono);
          font-size: 12px;
          color: var(--muted);
          letter-spacing: 0.1em;
          text-align: center;
          padding: 0 24px;
        }

        .runner-dot {
          width: 16px; height: 16px;
          border-radius: 50%;
          background: var(--accent);
          border: 3px solid #0a0a0a;
          box-shadow: 0 0 0 3px rgba(200,241,53,0.3);
        }
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
          whenCreated={(mapInstance) => {
            mapRef.current = mapInstance;
          }}
        >
          <TileLayer {...initMapTile} />

          {currentPos && <MapFlyTo center={[currentPos.lat, currentPos.lng]} />}

          {route.length > 0 && (
            <Polyline
              positions={route}
              pathOptions={{
                color: routeLineColor,
                weight: 3.5,
                opacity: 0.9,
                lineJoin: "round",
                lineCap: "round",
              }}
            />
          )}

          {loopPolygons.map((poly, idx) => (
            <Polygon
              key={`${idx}-${poly.length}`}
              positions={poly}
              pathOptions={{
                color: routeLineColor,
                fillColor: routeLineColor,
                fillOpacity: 0.08,
                weight: 1.5,
                dashArray: "4 4",
              }}
            />
          ))}

          {currentPos && (
            <Marker position={[currentPos.lat, currentPos.lng]} icon={runnerIcon} />
          )}
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
          <div className="stat active" id="stat-dist">
            <div className="stat-label">Distance</div>
            <div className="stat-value" id="val-dist">{totalDistKm.toFixed(2)}</div>
            <div className="stat-unit">km</div>
          </div>
          <div className="stat active" id="stat-pace">
            <div className="stat-label">Pace</div>
            <div className="stat-value" id="val-pace">{paceStr}</div>
            <div className="stat-unit">min/km</div>
          </div>
          <div className="stat active" id="stat-speed">
            <div className="stat-label">Speed</div>
            <div className="stat-value" id="val-speed">{speedKmh.toFixed(1)}</div>
            <div className="stat-unit">km/h</div>
          </div>
        </div>

        <div id="splits-wrap">
          <div id="splits-header">KM SPLITS</div>
          <div id="splits-list">{renderSplits()}</div>
        </div>

        <div id="controls">
          <button id="btn-start" className={buttonClass} onClick={toggleRun}>
            {buttonLabel}
          </button>
          <button id="btn-reset" onClick={resetRun} title="Reset">
            ↺
          </button>
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
