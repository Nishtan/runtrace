import React, { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, Marker, Polygon, Polyline, TileLayer, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import * as h3 from "h3-js";

// 🔥 Tuned for small urban loops
const H3_RESOLUTION = 12;
const INTERPOLATION_STEP_METERS = 6;

const CLOSE_DIST = 25;        // meters (closure threshold)
const MIN_LOOP_DIST = 80;     // meters (minimum loop length)
const MIN_POINTS_GAP = 8;     // avoid tiny oscillations
const MIN_UNIQUE_CELLS = 4;   // avoid straight jitter loops

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
    });
  }
  return pts;
}

function approxAreaM2(path) {
  if (path.length < 3) return 0;
  const mid = path[Math.floor(path.length / 2)];
  const latScale = 111320;
  const lngScale = 111320 * Math.cos((mid[0] * Math.PI) / 180);

  let area = 0;
  for (let i = 0; i < path.length; i++) {
    const j = (i + 1) % path.length;
    const x1 = path[i][1] * lngScale;
    const y1 = path[i][0] * latScale;
    const x2 = path[j][1] * lngScale;
    const y2 = path[j][0] * latScale;
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area / 2);
}

function MapFlyTo({ center }) {
  const map = useMap();
  useEffect(() => {
    if (center) map.panTo(center);
  }, [center]);
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
  const watchRef = useRef(null);
  const samplesRef = useRef([]);
  const lastPosRef = useRef(null);
  const lastAlertRef = useRef(0);

  const [route, setRoute] = useState([]);
  const [loops, setLoops] = useState([]);
  const [pos, setPos] = useState(null);
  const [running, setRunning] = useState(false);
  const [dist, setDist] = useState(0);
  const [speed, setSpeed] = useState(0);
  const [pace, setPace] = useState("--:--");
  const [alert, setAlert] = useState(null);

  function start() {
    if (!navigator.geolocation) return;
    setRunning(true);

    watchRef.current = navigator.geolocation.watchPosition((p) => {
      const { latitude, longitude, speed } = p.coords;
      const point = { lat: latitude, lng: longitude, ts: p.timestamp };

      setPos(point);
      setSpeed(speed ? speed * 3.6 : 0);
      setPace(paceFromSpeedKmh(speed ? speed * 3.6 : 0));

      if (lastPosRef.current) {
        const d = haversineKm(lastPosRef.current.lat, lastPosRef.current.lng, latitude, longitude);
        setDist((prev) => prev + d);
      }

      lastPosRef.current = point;
      setRoute((r) => [...r, [latitude, longitude]]);

      // interpolation + H3 tagging
      const prev = samplesRef.current[samplesRef.current.length - 1];
      const pts = prev ? interpolatePoints(prev, point, INTERPOLATION_STEP_METERS) : [point];

      pts.forEach((pt) => {
        const cell = h3.latLngToCell([pt.lat, pt.lng], H3_RESOLUTION);
        samplesRef.current.push({ ...pt, cell });
      });

      detectLoop();
    });
  }

  function stop() {
    setRunning(false);
    if (watchRef.current) navigator.geolocation.clearWatch(watchRef.current);
  }

  function detectLoop() {
    const pts = samplesRef.current;
    const n = pts.length;
    if (n < 20) return;

    const curr = pts[n - 1];

    for (let i = 0; i < n - MIN_POINTS_GAP; i++) {
      const prev = pts[i];

      // 🔥 MAIN FIX: distance-based closure
      const distClose = metersBetween(curr, prev);
      if (distClose > CLOSE_DIST) continue;

      // path distance
      let pathDist = 0;
      for (let j = i + 1; j < n; j++) {
        pathDist += metersBetween(pts[j - 1], pts[j]);
      }
      if (pathDist < MIN_LOOP_DIST) continue;

      // H3 uniqueness
      const cells = new Set();
      for (let j = i; j < n; j++) cells.add(pts[j].cell);
      if (cells.size < MIN_UNIQUE_CELLS) continue;

      // debounce
      if (Date.now() - lastAlertRef.current < 8000) return;
      lastAlertRef.current = Date.now();

      const loopPath = pts.slice(i).map((p) => [p.lat, p.lng]);
      const area = approxAreaM2(loopPath);

      setLoops((l) => [...l, loopPath]);
      setAlert(`Loop ${Math.round(pathDist)}m · Area ${Math.round(area)}m²`);

      setTimeout(() => setAlert(null), 5000);
      return;
    }
  }

  return (
    <div style={{ height: "100vh", background: "#0a0a0a" }}>
      <MapContainer
        center={[20.5937, 78.9629]}
        zoom={17}
        style={{ height: "70%" }}
        whenCreated={(m) => (mapRef.current = m)}
      >
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />

        {pos && <MapFlyTo center={[pos.lat, pos.lng]} />}

        <Polyline positions={route} pathOptions={{ color: "#c8f135" }} />

        {loops.map((l, i) => (
          <Polygon key={i} positions={l} pathOptions={{ color: "#c8f135", fillOpacity: 0.1 }} />
        ))}

        {pos && <Marker position={[pos.lat, pos.lng]} icon={runnerIcon} />}
      </MapContainer>

      <div style={{ padding: 20, color: "white" }}>
        <div>Distance: {dist.toFixed(2)} km</div>
        <div>Pace: {pace}</div>
        <div>Speed: {speed.toFixed(1)} km/h</div>

        <button onClick={running ? stop : start}>
          {running ? "Pause" : "Start"}
        </button>

        {alert && <div style={{ marginTop: 10, color: "#c8f135" }}>{alert}</div>}
      </div>
    </div>
  );
}
