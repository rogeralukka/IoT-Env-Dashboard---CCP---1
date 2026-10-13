/**
 * Global Device Store & Simulation Engine (Module-level Singleton).
 * Owns all hardware node state outside of the view lifecycle:
 * - Power state (default OFF)
 * - 1-second BOOT transition on power up
 * - Sampling rate (1s, 2s, 5s)
 * - Wi-Fi is always connected
 * - Weather baseline with gradual 10% ease per tick (zero sudden jump)
 * - Clean history buffer (zero points recorded while device is off)
 * - High-density 256x128 OLED vector rendering with subtle glow & faint pixel grid
 *
 * Continues running seamlessly across tab switches (Simulation <-> Web Interface).
 */

import {
  calculateDewPoint,
  calculateHeatIndex,
} from "../lib/formulas.js?v=3.2.0";
import { apiClient } from "../api/client.js?v=3.2.0";

/**
 * High-density 256x128 OLED display renderer.
 * Double-density SVG coordinate system using IBM Plex Mono / JetBrains Mono,
 * subtle cyan/blue phosphor glow, faint pixel-grid overlay, and generous spacing.
 * Identical output used for both the circuit diagram OLED and the zoomed view.
 */
export function renderOledSvg(state) {
  // Common SVG definitions: glow filter and faint 1px pixel grid pattern
  const defs = `
    <defs>
      <filter id="oledGlow" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="0.6" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
      <pattern id="oledPixelGrid" width="4" height="4" patternUnits="userSpaceOnUse">
        <path d="M 4 0 L 0 0 0 4" fill="none" stroke="#38bdf8" stroke-width="0.5" opacity="0.07" />
      </pattern>
    </defs>
  `;

  if (!state.isPoweredOn) {
    return `
      ${defs}
      <rect width="256" height="128" rx="4" fill="#02060a" />
      <rect width="256" height="128" fill="url(#oledPixelGrid)" pointer-events="none" />
      <text x="128" y="69" font-family="'IBM Plex Mono', 'JetBrains Mono', monospace" font-size="13" font-weight="500" fill="#475569" text-anchor="middle" letter-spacing="2">POWER OFF</text>
    `;
  }

  if (state.isBooting) {
    return `
      ${defs}
      <rect width="256" height="128" rx="4" fill="#02060a" />
      <rect width="256" height="128" fill="url(#oledPixelGrid)" pointer-events="none" />
      <g font-family="'IBM Plex Mono', 'JetBrains Mono', monospace" fill="#38bdf8" filter="url(#oledGlow)">
        <text x="128" y="56" font-size="16" font-weight="600" text-anchor="middle" letter-spacing="1">ESP32 BOOT</text>
        <text x="128" y="78" font-size="10.5" font-weight="400" text-anchor="middle" opacity="0.8">INITIALIZING SYSTEM...</text>
      </g>
    `;
  }

  // Running Operational State (4 Clean Rows with Generous Spacing)
  const rssi = state.rssi || -64;
  const pktStr = `PKT ${String(state.packetId || 0).padStart(3, "0")}`;
  const tStr = `${Number(state.temperature).toFixed(1)}C`;
  const rhStr = `${Math.round(state.humidity)}%`;
  const tempTrend = state.tempTrendArrow || "→";
  const rhTrend = state.rhTrendArrow || "→";

  // Row 3 text
  const hiVal = Number(state.heatIndex).toFixed(1);
  let hiWord = "NORMAL";
  const hiNum = Number(state.heatIndex);
  if (hiNum >= 41.0) hiWord = "DANGER";
  else if (hiNum >= 32.0) hiWord = "EXTREME";
  else if (hiNum >= 27.0) hiWord = "CAUTION";

  const dpVal = Number(state.dewPoint).toFixed(1);
  let dpWord = "COMFORT";
  const dpNum = Number(state.dewPoint);
  if (dpNum < 13.0) dpWord = "DRY";
  else if (dpNum > 18.0) dpWord = "MUGGY";

  // Row 4 footer text (strict 24-hour HH:MM:SS)
  const now = new Date();
  const pad2 = (n) => String(n).padStart(2, "0");
  const timeStr = state.timeStr || `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
  const upStr = state.uptimeStr || "UP 00:00:00";

  return `
    ${defs}
    <rect width="256" height="128" rx="4" fill="#02060a" />
    <rect width="256" height="128" fill="url(#oledPixelGrid)" pointer-events="none" />
    <g font-family="'IBM Plex Mono', 'JetBrains Mono', monospace" fill="#38bdf8" filter="url(#oledGlow)">
      <!-- Row 1 (y: 6 to 22): RSSI Signal Bars + dBm | "WIFI OK" | "AWS OK" | PKT counter -->
      <g>
        <rect x="10" y="18" width="2.5" height="3" fill="#38bdf8" />
        <rect x="14" y="15" width="2.5" height="6" fill="#38bdf8" />
        <rect x="18" y="12" width="2.5" height="9" fill="#38bdf8" />
        <rect x="22" y="9" width="2.5" height="12" fill="#38bdf8" />
      </g>
      <text x="29" y="19" font-size="10" font-weight="500">${rssi}dBm</text>
      <text x="104" y="19" font-size="10" font-weight="500" text-anchor="middle">WIFI OK</text>
      <text x="168" y="19" font-size="10" font-weight="500" text-anchor="middle">AWS OK</text>
      <text x="246" y="19" font-size="10" font-weight="600" text-anchor="end">${pktStr}</text>

      <!-- Divider 1 -->
      <line x1="10" y1="26" x2="246" y2="26" stroke="#38bdf8" stroke-width="1" opacity="0.45" />

      <!-- Row 2 (y: 28 to 70): Large TEMP with trend arrow & large HUM with trend arrow -->
      <text x="10" y="41" font-size="9" font-weight="500" opacity="0.75">TEMP</text>
      <text x="246" y="41" font-size="9" font-weight="500" opacity="0.75" text-anchor="end">HUM</text>
      <text x="10" y="66" font-size="24" font-weight="600">${tStr} <tspan font-size="18">${tempTrend}</tspan></text>
      <text x="246" y="66" font-size="24" font-weight="600" text-anchor="end">${rhStr} <tspan font-size="18">${rhTrend}</tspan></text>

      <!-- Divider 2 -->
      <line x1="10" y1="73" x2="246" y2="73" stroke="#38bdf8" stroke-width="1" opacity="0.45" />

      <!-- Row 3 (y: 75 to 109): HEAT IDX + level word, DEW PT + comfort word -->
      <text x="10" y="89" font-size="11.5" font-weight="500">HEAT IDX ${hiVal}C  <tspan font-weight="700">${hiWord}</tspan></text>
      <text x="10" y="105" font-size="11.5" font-weight="500">DEW PT   ${dpVal}C  <tspan font-weight="700">${dpWord}</tspan></text>

      <!-- Divider 3 -->
      <line x1="10" y1="112" x2="246" y2="112" stroke="#38bdf8" stroke-width="0.75" opacity="0.25" />

      <!-- Row 4 (y: 114 to 125): Current Time on Left, Uptime on Right -->
      <text x="10" y="123" font-size="9.5" font-weight="500" opacity="0.85">${timeStr}</text>
      <text x="246" y="123" font-size="9.5" font-weight="500" opacity="0.85" text-anchor="end">${upStr}</text>
    </g>
  `;
}

class DeviceStore {
  constructor() {
    // Default power state is OFF
    this.isPoweredOn = false;
    this.isBooting = false;
    this.bootTimeout = null;
    this.bootTime = null;

    // Operational Settings
    this.publishIntervalMs = 2000; // default 2s (0.5 Hz)

    // Telemetry State
    this.packetId = 0;
    this.rssi = -64;
    this.temperature = 29.0;
    this.humidity = 55.0;
    this.heatIndex = 30.5;
    this.dewPoint = 19.0;
    this.timestamp = Date.now() / 1000;
    this.sensorStatus = "OK";

    // Trend tracking
    this.prevTemp = 29.0;
    this.prevRh = 55.0;
    this.tempTrendArrow = "→";
    this.rhTrendArrow = "→";

    // Automatic Sensor Data Baseline & Bounded Drift
    this.baselineTemp = 29.0;
    this.targetBaselineTemp = 29.0;
    this.baselineRh = 55.0;
    this.targetBaselineRh = 55.0;
    this.driftTemp = 0.0;
    this.driftRh = 0.0;
    this.baselineLoaded = false;
    this.baselinePromise = null;

    // Rolling 30-Point History (empty while off; zero stale points)
    this.history = [];

    // Ticker and Subscribers
    this.tickerTimer = null;
    this.subscribers = new Set();
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;
    this.initialized = true;

    // Fetch baseline with 1.5s max timeout
    this.baselinePromise = this.initBaselineWeather();
    await this.baselinePromise;

    // Note: Do NOT push any points while device is off (Requirement 5)
    this.notify();
  }

  /**
   * Fetches baseline weather from Open-Meteo with a strict 1.5-second timeout.
   * If network or API is slow, smoothly falls back to 29.0°C / 55.0% without blocking.
   */
  async initBaselineWeather() {
    try {
      const weather = await Promise.race([
        apiClient.getWeather("Hasanparthy (Hanamkonda)").catch(() => null),
        new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
      ]);

      if (
        weather &&
        weather.current &&
        typeof weather.current.temperature_2m === "number" &&
        typeof weather.current.relative_humidity_2m === "number"
      ) {
        const t = Math.max(0.0, Math.min(50.0, weather.current.temperature_2m - 2.0));
        const h = Math.max(20.0, Math.min(90.0, weather.current.relative_humidity_2m + 8.0));
        this.targetBaselineTemp = Math.round(t * 10) / 10;
        this.targetBaselineRh = Math.round(h * 10) / 10;

        // If device has not been powered on yet, set baseline immediately to prevent any startup jump
        if (!this.isPoweredOn) {
          this.baselineTemp = this.targetBaselineTemp;
          this.baselineRh = this.targetBaselineRh;
          this.temperature = this.baselineTemp;
          this.humidity = this.baselineRh;
          this.heatIndex = calculateHeatIndex(this.baselineTemp, this.baselineRh);
          this.dewPoint = calculateDewPoint(this.baselineTemp, this.baselineRh);
        }
      }
    } catch {
      this.targetBaselineTemp = 29.0;
      this.targetBaselineRh = 55.0;
    } finally {
      this.baselineLoaded = true;
    }
  }

  subscribe(listener) {
    this.subscribers.add(listener);
    try {
      listener(this.getState(), this.getHistory());
    } catch (e) {
      console.warn("Subscriber immediate callback error:", e);
    }
    return () => this.subscribers.delete(listener);
  }

  notify() {
    const state = this.getState();
    const history = this.getHistory();
    for (const listener of this.subscribers) {
      try {
        listener(state, history);
      } catch (e) {
        console.warn("Subscriber notification error:", e);
      }
    }
  }

  getUptimeString() {
    if (!this.bootTime) return "UP 00:00:00";
    const sec = Math.max(0, Math.floor((Date.now() - this.bootTime) / 1000));
    const h = String(Math.floor(sec / 3600)).padStart(2, "0");
    const m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
    const s = String(sec % 60).padStart(2, "0");
    return `UP ${h}:${m}:${s}`;
  }

  getState() {
    const nowTimeStr = new Date().toTimeString().split(" ")[0];
    return {
      isPoweredOn: this.isPoweredOn,
      isBooting: this.isBooting,
      publishIntervalMs: this.publishIntervalMs,
      packetId: this.packetId,
      rssi: this.rssi,
      temperature: this.temperature,
      humidity: this.humidity,
      heatIndex: this.heatIndex,
      dewPoint: this.dewPoint,
      tempTrendArrow: this.tempTrendArrow,
      rhTrendArrow: this.rhTrendArrow,
      timestamp: this.timestamp,
      sensorStatus: this.sensorStatus,
      timeStr: nowTimeStr,
      uptimeStr: this.getUptimeString(),
    };
  }

  getHistory() {
    return [...this.history];
  }

  async togglePower() {
    const nextPower = !this.isPoweredOn;

    if (!nextPower) {
      // Turn OFF
      if (this.bootTimeout) {
        clearTimeout(this.bootTimeout);
        this.bootTimeout = null;
      }
      this.isPoweredOn = false;
      this.isBooting = false;
      this.bootTime = null;
      this.stopTicker();
      this.notify();
    } else {
      // Turn ON: Wait for baseline if not loaded, show 1s BOOT frame, then start readings
      this.isPoweredOn = true;
      this.isBooting = true;
      this.bootTime = Date.now();
      this.notify();

      if (!this.baselineLoaded && this.baselinePromise) {
        await Promise.race([
          this.baselinePromise,
          new Promise((resolve) => setTimeout(resolve, 1000)),
        ]);
      }

      if (this.bootTimeout) clearTimeout(this.bootTimeout);
      this.bootTimeout = setTimeout(() => {
        this.bootTimeout = null;
        this.isBooting = false;
        this.publishTick();
        this.startTicker();
        this.notify();
      }, 1000);
    }
  }

  setRate(speedMs) {
    this.publishIntervalMs = speedMs;
    if (this.isPoweredOn && !this.isBooting) {
      this.startTicker();
    }
    this.notify();
  }

  startTicker() {
    if (this.tickerTimer) clearInterval(this.tickerTimer);
    this.tickerTimer = setInterval(() => {
      if (this.isPoweredOn && !this.isBooting) {
        this.publishTick();
      }
    }, this.publishIntervalMs);
  }

  stopTicker() {
    if (this.tickerTimer) {
      clearInterval(this.tickerTimer);
      this.tickerTimer = null;
    }
  }

  async publishTick() {
    if (!this.isPoweredOn || this.isBooting) return;

    // Requirement 5: Ease toward weather baseline gradually (move 10% of gap per tick)
    if (Math.abs(this.targetBaselineTemp - this.baselineTemp) > 0.05) {
      this.baselineTemp += (this.targetBaselineTemp - this.baselineTemp) * 0.1;
    } else {
      this.baselineTemp = this.targetBaselineTemp;
    }
    if (Math.abs(this.targetBaselineRh - this.baselineRh) > 0.1) {
      this.baselineRh += (this.targetBaselineRh - this.baselineRh) * 0.1;
    } else {
      this.baselineRh = this.targetBaselineRh;
    }

    // Bounded random-walk drift + small ADC noise
    this.driftTemp += (Math.random() - 0.49) * 0.14;
    this.driftTemp = Math.max(-2.0, Math.min(2.0, this.driftTemp));

    this.driftRh += (Math.random() - 0.51) * 0.35;
    this.driftRh = Math.max(-5.0, Math.min(5.0, this.driftRh));

    const noiseT = (Math.random() - 0.5) * 0.15;
    const noiseRh = (Math.random() - 0.5) * 0.3;

    let t = this.baselineTemp + this.driftTemp + noiseT;
    let h = this.baselineRh + this.driftRh + noiseRh;

    t = Math.max(0.0, Math.min(50.0, Math.round(t * 10) / 10));
    h = Math.max(20.0, Math.min(90.0, Math.round(h)));

    const hi = Math.round(calculateHeatIndex(t, h) * 10) / 10;
    const dp = Math.round(calculateDewPoint(t, h) * 10) / 10;

    // Compute trend arrows
    const diffT = t - this.prevTemp;
    if (diffT > 0.1) this.tempTrendArrow = "↑";
    else if (diffT < -0.1) this.tempTrendArrow = "↓";
    else this.tempTrendArrow = "→";

    const diffRh = h - this.prevRh;
    if (diffRh > 0.5) this.rhTrendArrow = "↑";
    else if (diffRh < -0.5) this.rhTrendArrow = "↓";
    else this.rhTrendArrow = "→";

    this.prevTemp = t;
    this.prevRh = h;

    this.packetId++;
    const nowTs = Date.now() / 1000;
    const nowTimeStr = new Date().toTimeString().split(" ")[0];

    this.temperature = t;
    this.humidity = h;
    this.heatIndex = hi;
    this.dewPoint = dp;
    this.timestamp = nowTs;
    this.rssi = -62 - Math.floor(Math.random() * 6);
    this.sensorStatus = "OK";

    // Append to rolling 30-point history
    this.history.push({
      time: nowTimeStr,
      packet_id: this.packetId,
      temperature_c: t,
      humidity_pct: h,
      heat_index_c: hi,
    });
    if (this.history.length > 30) {
      this.history.shift();
    }

    const packet = {
      device_id: "ESP32-DHT11-NODE-01",
      packet_id: this.packetId,
      timestamp: nowTs,
      temperature_c: t,
      humidity_pct: h,
      wifi_rssi_dbm: this.rssi,
      sensor_status: "OK",
    };

    try {
      await apiClient.publishTelemetry(packet);
    } catch (err) {
      console.warn("Telemetry publish error:", err.message);
    }

    this.notify();
  }
}

// Export singleton instance
export const deviceStore = new DeviceStore();
