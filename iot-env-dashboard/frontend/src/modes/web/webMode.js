/**
 * Mode 1: Web Interface Module.
 * Distinct 3-Section Layout:
 * 1. Sensor Telemetry (ESP32 + DHT11 • AWS IoT Core Live Stream & Telemetry Graph)
 * 2. External Weather API (Open-Meteo Meteorological Station & 24h Diurnal Graph with Auto GPS)
 * 3. Sensor vs External Weather Comparison (Microclimate delta badges & 4-trace overlay graph)
 */

import {
  calculateDewPoint,
  calculateAbsoluteHumidity,
  calculateHeatIndex,
  celsiusToFahrenheit,
  getHeatIndexCategory,
  getDewPointComfortCategory,
} from "../../lib/formulas.js?v=3.2.0";
import { apiClient } from "../../api/client.js?v=3.2.0";
import { deviceStore } from "../../services/deviceStore.js?v=3.12.0";

/**
 * Formats a Date object or timestamp (ms) to strict 24-hour HH:MM:SS string.
 */
function format24Time(timestampMs = Date.now()) {
  const d = new Date(timestampMs);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Converts hex color code to rgba string.
 */
function hexToRgba(hex, alpha) {
  let c = hex.replace("#", "");
  if (c.length === 3) c = c.split("").map((x) => x + x).join("");
  const num = parseInt(c, 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Creates dynamic vertical gradient from line color at topAlpha down to 0% at bottom.
 */
function getVerticalGradient(context, hexColor, topAlpha = 0.22) {
  const chart = context.chart;
  const { ctx, chartArea } = chart;
  if (!chartArea) return null;
  const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
  gradient.addColorStop(0, hexToRgba(hexColor, topAlpha));
  gradient.addColorStop(1, hexToRgba(hexColor, 0));
  return gradient;
}

/**
 * Generates lightweight vector sparkline SVG (20 points, no axes, endpoint dot).
 */
export function generateSparklineSvg(points, strokeColor) {
  if (!points || points.length < 2) {
    return `<line x1="0" y1="12" x2="100" y2="12" stroke="${strokeColor}" stroke-dasharray="2,2" stroke-width="1.5" opacity="0.35"/>`;
  }
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min === 0 ? 1 : max - min;
  const padding = 2;
  const w = 100;
  const h = 24;

  const coords = points.map((p, i) => {
    const x = ((i / (points.length - 1)) * w).toFixed(1);
    const y = (h - padding - ((p - min) / range) * (h - 2 * padding)).toFixed(1);
    return { x, y };
  });

  const polylinePoints = coords.map((c) => `${c.x},${c.y}`).join(" ");
  const polygonPoints = `0,${h} ${polylinePoints} ${w},${h}`;
  const lastPoint = coords[coords.length - 1];

  return `
    <polygon points="${polygonPoints}" fill="${strokeColor}" fill-opacity="0.14" />
    <polyline points="${polylinePoints}" fill="none" stroke="${strokeColor}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
    <circle cx="${lastPoint.x}" cy="${lastPoint.y}" r="2.5" fill="${strokeColor}" stroke="var(--bg-card)" stroke-width="1" />
  `;
}

/**
 * Categorizes relative humidity into standard comfort levels.
 */
export function getHumidityComfort(rh) {
  if (rh < 30) {
    return { label: "Dry", level: "dry", colorClass: "badge-dry", desc: "Low Moisture Air" };
  }
  if (rh <= 60) {
    return { label: "Comfortable", level: "comfortable", colorClass: "badge-comfortable", desc: "Optimal Range" };
  }
  return { label: "Humid", level: "humid", colorClass: "badge-humid", desc: "High Moisture Air" };
}

/**
 * Condensation & mold risk rating based on RH and temperature-dew point spread.
 */
export function getMoldCondensationRisk(rh, spread) {
  if (rh >= 70 || spread <= 3.0) {
    return { label: "High Risk", level: "high", colorClass: "badge-danger" };
  }
  if (rh >= 60 || spread <= 6.0) {
    return { label: "Med Risk", level: "medium", colorClass: "badge-caution" };
  }
  return { label: "Low Risk", level: "low", colorClass: "badge-normal" };
}

/**
 * Human dew point comfort descriptor.
 */
export function getDewPointDescriptor(dp) {
  if (dp < 10) return "Dry";
  if (dp <= 16) return "Comfortable";
  if (dp <= 21) return "Muggy";
  return "Oppressive";
}

export class WebMode {
  constructor(container) {
    this.container = container;

    // Location state
    this.selectedCity = "Hasanparthy (Hanamkonda)";
    this.isAutoLocation = false;
    this.currentCoords = null;

    // Data state
    this.weatherData = null;
    this.latestSensorReading = null;

    // Rolling sensor history (max 30 points)
    this.sensorHistory = [];
    this.packetCounter = 0;
    this.isStreamingActive = true;

    // Extended rolling histories for individual card sparklines and trends (~20 points)
    this.indoorTempHistory = [];
    this.indoorRhHistory = [];
    this.indoorHiHistory = [];
    this.indoorDpHistory = [];
    this.indoorMinTemp = null;
    this.indoorMaxTemp = null;

    // Chart instances
    this.sensorChart = null;
    this.weatherChart = null;
    this.comparisonChart = null;

    // Timers
    this.weatherRefreshTimer = null;
    this.sensorTickerTimer = null;
    this.chartRetryTimer = null;

    // Seed historical sensor data if device was already running or has packets
    const currentDevState = deviceStore.getState();
    if (currentDevState && (currentDevState.isPoweredOn || currentDevState.packetId > 0)) {
      this._seedHistoricalSensorData();
    }
  }

  /**
   * Generates realistic initial sensor telemetry history (15 points).
   */
  _seedHistoricalSensorData() {
    const now = Date.now();
    const baseTemp = 30.5;
    const baseRh = 52.0;

    this.indoorTempHistory = [];
    this.indoorRhHistory = [];
    this.indoorHiHistory = [];
    this.indoorDpHistory = [];
    this.indoorMinTemp = null;
    this.indoorMaxTemp = null;

    for (let i = 14; i >= 0; i--) {
      const ts = now - i * 3000;
      const noiseT = (Math.sin(i * 0.8) * 0.6) + ((Math.random() - 0.5) * 0.3);
      const noiseRh = (-Math.sin(i * 0.8) * 1.2) + ((Math.random() - 0.5) * 0.6);
      const temp = Math.round((baseTemp + noiseT) * 10) / 10;
      const hum = Math.round((baseRh + noiseRh) * 10) / 10;
      const hi = calculateHeatIndex(temp, hum);
      const dp = calculateDewPoint(temp, hum);

      const timeLabel = format24Time(ts);

      this.packetCounter++;
      this.sensorHistory.push({
        packet_id: this.packetCounter,
        time: timeLabel,
        timestamp: ts / 1000,
        temperature_c: temp,
        humidity_pct: hum,
        heat_index_c: hi,
        dew_point_c: dp,
        absolute_humidity_gm3: calculateAbsoluteHumidity(temp, hum),
        wifi_rssi_dbm: -60 - Math.floor(Math.random() * 8),
      });

      this.indoorTempHistory.push(temp);
      this.indoorRhHistory.push(hum);
      this.indoorHiHistory.push(hi);
      this.indoorDpHistory.push(dp);
      this.indoorMinTemp = Math.min(this.indoorMinTemp ?? temp, temp);
      this.indoorMaxTemp = Math.max(this.indoorMaxTemp ?? temp, temp);
    }

    const currentDevState = deviceStore.getState();
    if (currentDevState && currentDevState.packetId > 0) {
      const temp = currentDevState.temperature;
      const hum = currentDevState.humidity;
      const hi = currentDevState.heatIndex;
      const dp = currentDevState.dewPoint;
      const last = this.sensorHistory[this.sensorHistory.length - 1];
      if (last) {
        last.temperature_c = temp;
        last.humidity_pct = hum;
        last.heat_index_c = hi;
        last.dew_point_c = dp;
        last.packet_id = currentDevState.packetId;
        last.absolute_humidity_gm3 = calculateAbsoluteHumidity(temp, hum);
      }
      this.indoorTempHistory[this.indoorTempHistory.length - 1] = temp;
      this.indoorRhHistory[this.indoorRhHistory.length - 1] = hum;
      this.indoorHiHistory[this.indoorHiHistory.length - 1] = hi;
      this.indoorDpHistory[this.indoorDpHistory.length - 1] = dp;
      this.indoorMinTemp = Math.min(this.indoorMinTemp ?? temp, temp);
      this.indoorMaxTemp = Math.max(this.indoorMaxTemp ?? temp, temp);
    }

    this.latestSensorReading = this.sensorHistory[this.sensorHistory.length - 1];
  }

  /**
   * Called when theme changes (light <-> dark).
   */
  onThemeChange(newTheme) {
    if (this.sensorChart) {
      this.sensorChart.destroy();
      this.sensorChart = null;
    }
    this.initSensorChart();
    this.updateSensorChart();

    if (this.weatherData && this.weatherData.hourly) {
      this.renderWeatherChart(this.weatherData.hourly);
    }

    if (this.comparisonChart) {
      this.comparisonChart.destroy();
      this.comparisonChart = null;
    }
    this.initComparisonChart();
    this.updateComparisonChart();
  }

  /**
   * Handles device power state from deviceStore.
   * - If device is OFF: show last known values dimmed with a "Device off, power it on in Simulation" note banner.
   * - If never on: show "-" values with the same note banner.
   */
  handleDevicePowerState(state) {
    const notice = this.container.querySelector("#indoorDeviceOffNotice");
    const grid = this.container.querySelector("#indoorMetricsGrid");
    if (!notice || !grid) return;

    if (!state.isPoweredOn) {
      notice.classList.remove("hidden");
      grid.classList.add("is-device-off");

      const packetBadge = this.container.querySelector("#sensorPacketBadge");
      if (packetBadge) {
        packetBadge.className = "card-badge badge-caution mono-num";
        packetBadge.textContent = "OFFLINE";
      }

      // If never on (no packets recorded and packetId is 0), show "-" values
      if (state.packetId === 0 && (!this.latestSensorReading || this.latestSensorReading.packet_id === 0)) {
        this.renderOffBlankIndoorUI();
      } else if (this.latestSensorReading) {
        this.updateSensorUI(this.latestSensorReading);
      }
    } else {
      notice.classList.add("hidden");
      grid.classList.remove("is-device-off");

      const packetBadge = this.container.querySelector("#sensorPacketBadge");
      if (packetBadge) {
        packetBadge.className = "card-badge badge-normal mono-num";
        packetBadge.textContent = `Packet: #${this.packetCounter || state.packetId}`;
      }

      if (this.latestSensorReading) {
        this.updateSensorUI(this.latestSensorReading);
      }
    }
  }

  /**
   * Renders blank "-" state for indoor cards when device was never turned on.
   */
  renderOffBlankIndoorUI() {
    const el = (id) => this.container.querySelector(id);

    if (el("#sensorTempMainVal")) el("#sensorTempMainVal").innerHTML = `-<span class="metric-unit">°C</span>`;
    if (el("#sensorTempFVal")) el("#sensorTempFVal").textContent = `-°F`;
    if (el("#sensorTempFeelsVal")) el("#sensorTempFeelsVal").textContent = `-°C`;
    if (el("#sensorTempTrend")) {
      el("#sensorTempTrend").className = "trend-indicator trend-steady";
      el("#sensorTempTrend").innerHTML = `<span class="trend-arrow">→</span><span class="trend-label">Steady</span>`;
    }
    if (el("#sensorTempMinVal")) el("#sensorTempMinVal").textContent = `-°C`;
    if (el("#sensorTempMaxVal")) el("#sensorTempMaxVal").textContent = `-°C`;
    if (el("#sensorTempRangeFill")) el("#sensorTempRangeFill").style.width = `0%`;
    if (el("#sensorTempMarkerPin")) el("#sensorTempMarkerPin").style.left = `50%`;
    if (el("#sensorTempSparkline")) {
      el("#sensorTempSparkline").innerHTML = `<line x1="0" y1="12" x2="100" y2="12" stroke="var(--border-ink)" stroke-dasharray="2,2" stroke-width="1.5" opacity="0.25"/>`;
    }

    if (el("#sensorRhMainVal")) el("#sensorRhMainVal").textContent = `-`;
    if (el("#sensorAhMainVal")) el("#sensorAhMainVal").textContent = `-`;
    if (el("#sensorHumTag")) {
      el("#sensorHumTag").className = "card-badge badge-caution";
      el("#sensorHumTag").textContent = "Device Off";
    }
    if (el("#sensorRhComfortDesc")) el("#sensorRhComfortDesc").textContent = "Offline";
    if (el("#sensorRhMarkerPin")) el("#sensorRhMarkerPin").style.left = `50%`;
    if (el("#sensorRhSparkline")) {
      el("#sensorRhSparkline").innerHTML = `<line x1="0" y1="12" x2="100" y2="12" stroke="var(--border-ink)" stroke-dasharray="2,2" stroke-width="1.5" opacity="0.25"/>`;
    }

    if (el("#sensorHiMainVal")) el("#sensorHiMainVal").innerHTML = `-<span class="metric-unit">°C</span>`;
    if (el("#sensorHiDiffVal")) el("#sensorHiDiffVal").textContent = `- vs air`;
    if (el("#sensorHiBadge")) {
      el("#sensorHiBadge").className = "card-badge badge-normal";
      el("#sensorHiBadge").textContent = "Normal";
    }
    const lblNormal = el("#sensorHiLblNormal");
    const lblCaution = el("#sensorHiLblCaution");
    const lblExtreme = el("#sensorHiLblExtreme");
    const lblDanger = el("#sensorHiLblDanger");
    if (lblNormal) lblNormal.className = "hi-lbl lbl-normal active";
    if (lblCaution) lblCaution.className = "hi-lbl lbl-caution";
    if (lblExtreme) lblExtreme.className = "hi-lbl lbl-extreme";
    if (lblDanger) lblDanger.className = "hi-lbl lbl-danger";
    if (el("#sensorHiMarkerPin")) el("#sensorHiMarkerPin").style.left = `12.5%`;
    if (el("#sensorHiSparkline")) {
      el("#sensorHiSparkline").innerHTML = `<line x1="0" y1="12" x2="100" y2="12" stroke="var(--border-ink)" stroke-dasharray="2,2" stroke-width="1.5" opacity="0.25"/>`;
    }

    if (el("#sensorDpMainVal")) el("#sensorDpMainVal").innerHTML = `-<span class="metric-unit">°C</span>`;
    if (el("#sensorDpSpreadVal")) el("#sensorDpSpreadVal").textContent = `Spread -°C`;
    if (el("#sensorDpComfortWord")) el("#sensorDpComfortWord").textContent = `-`;
    if (el("#sensorDpRiskBadge")) {
      el("#sensorDpRiskBadge").className = "card-badge badge-normal";
      el("#sensorDpRiskBadge").textContent = "Low Risk";
    }
    if (el("#sensorDpRangeFill")) el("#sensorDpRangeFill").style.width = `0%`;
    if (el("#sensorDpMarkerPin")) el("#sensorDpMarkerPin").style.left = `50%`;
    if (el("#sensorDpSparkline")) {
      el("#sensorDpSparkline").innerHTML = `<line x1="0" y1="12" x2="100" y2="12" stroke="var(--border-ink)" stroke-dasharray="2,2" stroke-width="1.5" opacity="0.25"/>`;
    }
  }

  /**
   * Initializes Web Mode.
   */
  async init() {
    this.renderSkeleton();

    // Check device power state immediately
    const initialDevState = deviceStore.getState();
    this.handleDevicePowerState(initialDevState);

    // Render initial sensor cards & sensor chart right away if powered on
    if (this.latestSensorReading && initialDevState.isPoweredOn) {
      this.updateSensorUI(this.latestSensorReading);
    }
    this.initSensorChart();
    this.updateSensorChart();
    this.initComparisonChart();
    this.updateComparisonChart();

    // Fetch initial weather data
    await this.fetchWeatherData();

    // Subscribe to global deviceStore singleton for sensor readings & power status
    this.unsubscribeStore = deviceStore.subscribe((state) => {
      this.handleDevicePowerState(state);
      if (state.isPoweredOn && !state.isBooting && state.packetId > 0) {
        this.handleLocalSensorPacket({
          device_id: "ESP32-DHT11-NODE-01",
          packet_id: state.packetId,
          timestamp: state.timestamp,
          temperature_c: state.temperature,
          humidity_pct: state.humidity,
          wifi_rssi_dbm: state.rssi,
          sensor_status: state.sensorStatus,
        });
      }
    });

    // Auto-refresh weather API every 5 minutes
    if (this.weatherRefreshTimer) clearInterval(this.weatherRefreshTimer);
    this.weatherRefreshTimer = setInterval(() => {
      this.fetchWeatherData(true);
    }, 5 * 60 * 1000);

    // Defensive Chart.js CDN readiness check
    if (typeof Chart === "undefined") {
      let retries = 0;
      this.chartRetryTimer = setInterval(() => {
        retries++;
        if (typeof Chart !== "undefined" || retries > 15) {
          clearInterval(this.chartRetryTimer);
          this.initSensorChart();
          this.updateSensorChart();
          if (this.weatherData && this.weatherData.hourly) {
            this.renderWeatherChart(this.weatherData.hourly);
          }
          this.initComparisonChart();
          this.updateComparisonChart();
        }
      }, 250);
    }
  }

  /**
   * Cleans up all active timers and charts.
   */
  destroy() {
    if (this.unsubscribeStore) {
      this.unsubscribeStore();
      this.unsubscribeStore = null;
    }
    if (this.weatherRefreshTimer) {
      clearInterval(this.weatherRefreshTimer);
      this.weatherRefreshTimer = null;
    }
    if (this.sensorTickerTimer) {
      clearInterval(this.sensorTickerTimer);
      this.sensorTickerTimer = null;
    }
    if (this.chartRetryTimer) {
      clearInterval(this.chartRetryTimer);
      this.chartRetryTimer = null;
    }
    if (this.sensorChart) {
      this.sensorChart.destroy();
      this.sensorChart = null;
    }
    if (this.weatherChart) {
      this.weatherChart.destroy();
      this.weatherChart = null;
    }
    if (this.comparisonChart) {
      this.comparisonChart.destroy();
      this.comparisonChart = null;
    }
  }

  /**
   * Starts periodic virtual sensor telemetry generator.
   * Posts to `/api/device/publish` to exercise virtual AWS cloud pipeline.
   */
  startSensorTelemetryTick() {
    if (this.sensorTickerTimer) clearInterval(this.sensorTickerTimer);

    this.sensorTickerTimer = setInterval(async () => {
      if (!this.isStreamingActive) return;

      const prev = this.latestSensorReading || {
        temperature_c: 30.5,
        humidity_pct: 52.0,
      };

      // Natural micro-drift: clamp to reasonable room conditions
      const deltaT = (Math.random() - 0.48) * 0.25;
      const deltaRh = (Math.random() - 0.52) * 0.45;
      const nextTemp = Math.round(Math.min(Math.max(prev.temperature_c + deltaT, 24.0), 38.0) * 10) / 10;
      const nextRh = Math.round(Math.min(Math.max(prev.humidity_pct + deltaRh, 30.0), 85.0) * 10) / 10;

      const packet = {
        device_id: "ESP32-DHT11-NODE-01",
        packet_id: ++this.packetCounter,
        timestamp: Date.now() / 1000,
        temperature_c: nextTemp,
        humidity_pct: nextRh,
        wifi_rssi_dbm: -60 - Math.floor(Math.random() * 8),
      };

      // Ingest into virtual AWS backend asynchronously
      try {
        await apiClient.publishTelemetry(packet);
      } catch (err) {
        // Fallback local update if network is busy
        this.handleLocalSensorPacket(packet);
      }
    }, 2500);
  }

  /**
   * Ingests a sensor packet (from SSE stream or local ticker).
   */
  handleLocalSensorPacket(packet) {
    const timeLabel = format24Time((packet.timestamp || Date.now() / 1000) * 1000);

    const temp = Number(packet.temperature_c);
    const hum = Number(packet.humidity_pct);

    const fullRecord = {
      packet_id: packet.packet_id || ++this.packetCounter,
      time: timeLabel,
      timestamp: packet.timestamp || Date.now() / 1000,
      temperature_c: temp,
      humidity_pct: hum,
      heat_index_c: packet.heat_index_c ?? calculateHeatIndex(temp, hum),
      dew_point_c: packet.dew_point_c ?? calculateDewPoint(temp, hum),
      absolute_humidity_gm3: packet.absolute_humidity_gm3 ?? calculateAbsoluteHumidity(temp, hum),
      wifi_rssi_dbm: packet.wifi_rssi_dbm || -64,
    };

    this.latestSensorReading = fullRecord;
    this.sensorHistory.push(fullRecord);
    if (this.sensorHistory.length > 25) {
      this.sensorHistory.shift();
    }

    this.updateSensorUI(fullRecord);
    this.updateSensorChart();
    this.updateDeltaCards();
    this.updateComparisonChart();
  }

  /**
   * Renders the complete 3-section skeleton.
   */
  renderSkeleton() {
    this.container.innerHTML = `
      <!-- Hazard Alert Banner -->
      <aside id="hazardAlertBanner" class="hazard-banner hidden" role="alert" aria-live="assertive">
        <div class="hazard-content">
          <span class="hazard-icon" style="display: inline-flex; align-items: center; color: currentColor;">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>
              <line x1="12" y1="9" x2="12" y2="13"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
          </span>
          <div>
            <div id="hazardAlertTitle" class="hazard-title">Environmental Threshold Alert</div>
            <div id="hazardAlertDesc" class="hazard-desc">Elevated heat index or humidity detected.</div>
          </div>
        </div>
        <button id="dismissHazardBtn" class="btn-refresh" style="padding: 0.3rem 0.6rem; font-size: 0.75rem;" aria-label="Dismiss alert">Dismiss</button>
      </aside>

      <!-- ================================================================= -->
      <!-- SECTION 1: PHYSICAL SENSOR NODE TELEMETRY (TOP SECTION)          -->
      <!-- ================================================================= -->
      <section class="section-block" aria-labelledby="secSensorHeading">
        <div class="section-header-banner">
          <div class="section-header-info">
            <h2 id="secSensorHeading" class="section-title">
              <span class="section-tag-dot" aria-hidden="true"></span>
              Indoor (DHT11)
            </h2>
          </div>

          <div class="toolbar-right">
            <span id="sensorPacketBadge" class="card-badge badge-normal mono-num">Packet: #${this.packetCounter}</span>
            <span id="sensorRssiBadge" class="card-badge badge-comfortable mono-num" style="display: inline-flex; align-items: center; gap: 0.35rem;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M5 12.55a11 11 0 0 1 14.08 0"/>
                <path d="M1.42 9a16 16 0 0 1 21.16 0"/>
                <path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>
                <line x1="12" y1="20" x2="12.01" y2="20"/>
              </svg>
              <span>-64 dBm</span>
            </span>
            <button id="toggleSensorStreamBtn" class="status-toggle-pill is-streaming" role="switch" aria-checked="true" title="Pause or resume live sensor telemetry">
              <span class="status-stream-dot" aria-hidden="true"></span>
              <span id="sensorStreamStatusLabel">Live Streaming</span>
            </button>
          </div>
        </div>

        <!-- Device Off Notice Banner -->
        <div id="indoorDeviceOffNotice" class="indoor-device-off-notice hidden" role="note">
          <span class="notice-icon" style="display: inline-flex; align-items: center; color: currentColor;">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 22v-5"/>
              <path d="M9 8V2"/>
              <path d="M15 2v6"/>
              <path d="M18 8H6a4 4 0 0 0-4 4v1a3 3 0 0 0 3 3h14a3 3 0 0 0 3-3v-1a4 4 0 0 0-4-4z"/>
            </svg>
          </span>
          <span class="notice-text">Device off, power it on in Simulation</span>
        </div>

        <!-- 4 Metric Cards for Indoor Sensor Node -->
        <div class="metrics-grid" id="indoorMetricsGrid" aria-label="Current sensor node metrics">
          <!-- Card 1: Sensor Temperature -->
          <article class="metric-card" id="cardSensorTemp">
            <div class="card-header">
              <span class="card-title">Temperature</span>
              <span class="card-badge badge-normal" id="sensorTempTag">Indoor</span>
            </div>
            <div class="card-body-content">
              <div class="temp-readings-row">
                <div class="metric-main-value mono-num" id="sensorTempMainVal">--.-<span class="metric-unit">°C</span></div>
                <div class="temp-secondary-val mono-num" id="sensorTempFVal">--.-°F</div>
              </div>
              <div class="metric-secondary-row">
                <span class="metric-secondary-item">
                  <span class="sec-label">Feels</span>
                  <strong class="mono-num" id="sensorTempFeelsVal">--.-°C</strong>
                </span>
                <span class="trend-indicator trend-steady" id="sensorTempTrend">
                  <span class="trend-arrow">→</span>
                  <span class="trend-label">Steady</span>
                </span>
              </div>
              <div class="metric-range-block">
                <div class="range-labels-row">
                  <span class="mono-num" id="sensorTempMinVal">--.-°C</span>
                  <span class="range-center-label">Session Range</span>
                  <span class="mono-num" id="sensorTempMaxVal">--.-°C</span>
                </div>
                <div class="metric-track-with-marker" title="Temperature Session Range">
                  <div class="range-fill-bar" id="sensorTempRangeFill" style="width: 50%; background-color: var(--chart-local-temp);"></div>
                  <div class="range-marker-pin" id="sensorTempMarkerPin" style="left: 50%;"></div>
                </div>
              </div>
            </div>
            <div class="card-sparkline-wrap" id="sensorTempSparklineWrap">
              <svg class="card-sparkline" id="sensorTempSparkline" viewBox="0 0 100 24" preserveAspectRatio="none"></svg>
            </div>
          </article>

          <!-- Card 2: Sensor Atmospheric Humidity -->
          <article class="metric-card" id="cardSensorHumidity">
            <div class="card-header">
              <span class="card-title">Humidity</span>
              <span class="card-badge badge-comfortable" id="sensorHumTag">Comfortable</span>
            </div>
            <div class="card-body-content">
              <div class="humidity-dual-large">
                <div class="hum-col">
                  <div class="hum-val-row">
                    <span class="hum-large-val mono-num" id="sensorRhMainVal">--</span>
                    <span class="hum-large-unit">%</span>
                  </div>
                  <span class="hum-col-caption">Relative</span>
                </div>
                <div class="hum-divider"></div>
                <div class="hum-col">
                  <div class="hum-val-row">
                    <span class="hum-large-val mono-num" id="sensorAhMainVal">--.-</span>
                    <span class="hum-large-unit">g/m³</span>
                  </div>
                  <span class="hum-col-caption">Absolute</span>
                </div>
              </div>
              <div class="metric-secondary-row">
                <span class="metric-secondary-item">
                  <span class="sec-label">Zone</span>
                  <strong class="mono-num" id="sensorRhComfortDesc">Optimal Range</strong>
                </span>
              </div>
              <div class="metric-range-block">
                <div class="range-labels-row">
                  <span class="mono-num">0%</span>
                  <span class="range-zone-caption">30–60% Ideal</span>
                  <span class="mono-num">100%</span>
                </div>
                <div class="metric-track-with-marker humidity-track-with-comfort" title="Humidity Scale (30-60% optimal shaded)">
                  <div class="comfort-zone-shade" style="left: 30%; width: 30%;"></div>
                  <div class="range-marker-pin" id="sensorRhMarkerPin" style="left: 50%;"></div>
                </div>
              </div>
            </div>
            <div class="card-sparkline-wrap" id="sensorRhSparklineWrap">
              <svg class="card-sparkline" id="sensorRhSparkline" viewBox="0 0 100 24" preserveAspectRatio="none"></svg>
            </div>
          </article>

          <!-- Card 3: Sensor Heat Index -->
          <article class="metric-card" id="cardSensorHeatIndex">
            <div class="card-header">
              <span class="card-title">Heat Index</span>
              <span class="card-badge badge-normal" id="sensorHiBadge">Normal</span>
            </div>
            <div class="card-body-content">
              <div class="metric-main-value mono-num" id="sensorHiMainVal">--.-<span class="metric-unit">°C</span></div>
              <div class="metric-secondary-row">
                <span class="metric-secondary-item">
                  <strong class="mono-num" id="sensorHiDiffVal">+0.0°C vs air</strong>
                </span>
              </div>
              <div class="hi-scale-block">
                <div class="hi-marker-row">
                  <div class="hi-triangle-marker" id="sensorHiMarkerPin" style="left: 12.5%;"></div>
                </div>
                <div class="hi-four-segment-bar">
                  <div class="hi-seg hi-seg-normal"></div>
                  <div class="hi-seg hi-seg-caution"></div>
                  <div class="hi-seg hi-seg-extreme"></div>
                  <div class="hi-seg hi-seg-danger"></div>
                </div>
                <div class="hi-labels-row">
                  <span class="hi-lbl lbl-normal active" id="sensorHiLblNormal">Normal</span>
                  <span class="hi-lbl lbl-caution" id="sensorHiLblCaution">Caution</span>
                  <span class="hi-lbl lbl-extreme" id="sensorHiLblExtreme">Extreme</span>
                  <span class="hi-lbl lbl-danger" id="sensorHiLblDanger">Danger</span>
                </div>
              </div>
            </div>
            <div class="card-sparkline-wrap" id="sensorHiSparklineWrap">
              <svg class="card-sparkline" id="sensorHiSparkline" viewBox="0 0 100 24" preserveAspectRatio="none"></svg>
            </div>
          </article>

          <!-- Card 4: Sensor Dew Point -->
          <article class="metric-card" id="cardSensorDewPoint">
            <div class="card-header">
              <span class="card-title">Dew Point</span>
              <span class="card-badge badge-normal" id="sensorDpRiskBadge">Low Risk</span>
            </div>
            <div class="card-body-content">
              <div class="metric-main-value mono-num" id="sensorDpMainVal">--.-<span class="metric-unit">°C</span></div>
              <div class="metric-secondary-row">
                <span class="metric-secondary-item">
                  <strong class="mono-num" id="sensorDpSpreadVal">Spread --.-°C</strong>
                </span>
                <span class="comfort-word-badge" id="sensorDpComfortWord">Comfortable</span>
              </div>
              <div class="metric-range-block">
                <div class="range-labels-row">
                  <span class="mono-num">0°C</span>
                  <span class="range-center-label">Condensation</span>
                  <span class="mono-num">30°C</span>
                </div>
                <div class="metric-track-with-marker" title="Dew Point Scale">
                  <div class="range-fill-bar" id="sensorDpRangeFill" style="width: 50%; background-color: var(--accent-cyan);"></div>
                  <div class="range-marker-pin" id="sensorDpMarkerPin" style="left: 50%;"></div>
                </div>
              </div>
            </div>
            <div class="card-sparkline-wrap" id="sensorDpSparklineWrap">
              <svg class="card-sparkline" id="sensorDpSparkline" viewBox="0 0 100 24" preserveAspectRatio="none"></svg>
            </div>
          </article>
        </div>

        <!-- Sensor Live Graph -->
        <article class="chart-card">
          <div class="chart-header">
            <div class="chart-titles">
              <h2>Live Telemetry</h2>
            </div>
            <div class="chart-legend-custom">
              <span class="legend-item"><span class="legend-line" style="background-color: var(--chart-local-temp, #ea580c);"></span> Sensor Temp (°C)</span>
              <span class="legend-item"><span class="legend-line" style="background-color: var(--chart-local-rh, #167a3f);"></span> Sensor RH (%RH)</span>
            </div>
          </div>
          <div class="chart-container-wrapper">
            <div id="sensorChartEmptyState" class="chart-empty-state">Power on the device to start recording</div>
            <canvas id="sensorTelemetryChart" aria-label="Sensor real-time telemetry chart" role="img"></canvas>
          </div>
        </article>
      </section>

      <!-- ================================================================= -->
      <!-- SECTION 2: EXTERNAL WEATHER API (MIDDLE SECTION)                  -->
      <!-- ================================================================= -->
      <section class="section-block" aria-labelledby="secWeatherHeading">
        <div class="section-header-banner">
          <div class="section-header-info">
            <h2 id="secWeatherHeading" class="section-title">
              <span style="display: inline-flex; align-items: center; color: currentColor;">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>
                </svg>
              </span>
              Outdoor (Open-Meteo)
            </h2>
          </div>

          <!-- Location Selection Controls in this API Section -->
          <div class="toolbar-left" style="flex-wrap: wrap; gap: 0.75rem;">
            <button id="autoLocationBtn" class="btn-auto-loc" title="Auto-detect current location using device GPS">
              <span style="display: inline-flex; align-items: center; color: currentColor;">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/>
                  <circle cx="12" cy="10" r="3"/>
                </svg>
              </span>
              <span id="autoLocationText">Auto (Device GPS)</span>
            </button>

            <div class="city-select-group">
              <label for="cityDropdown" class="city-select-label">Station</label>
              <select id="cityDropdown" class="city-select" aria-label="Select manual weather monitoring station">
                <option value="Hasanparthy (Hanamkonda)" selected>Hasanparthy (Hanamkonda) - SRU</option>
                <option value="Hyderabad">Hyderabad</option>
                <option value="Warangal">Warangal</option>
                <option value="Bengaluru">Bengaluru</option>
                <option value="Delhi">Delhi</option>
                <option value="Mumbai">Mumbai</option>
              </select>
            </div>

            <div id="locationCoordsBadge" class="location-coord-badge">
              PIN: 506371 • 18°04′05″N 79°31′25″E
            </div>

            <div style="display: flex; align-items: center; gap: 0.5rem; margin-left: auto;">
              <span id="lastUpdatedLabel" class="last-updated-text mono-num">Updating...</span>
              <button id="refreshWeatherBtn" class="btn-refresh" title="Refresh meteorological observations">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
                </svg>
                <span>Refresh</span>
              </button>
            </div>
          </div>
        </div>

        <!-- 4 Metric Cards for Weather API (Exact Same Layout as Indoor) -->
        <div class="metrics-grid" id="outdoorMetricsGrid" aria-label="Current weather station metrics">
          <!-- Card 1: API Temperature -->
          <article class="metric-card" id="cardWeatherTemp">
            <div class="card-header">
              <span class="card-title">Temperature</span>
              <span class="card-badge badge-normal" id="weatherTempTag">Station</span>
            </div>
            <div class="card-body-content">
              <div class="temp-readings-row">
                <div class="metric-main-value mono-num" id="weatherTempMainVal">--.-<span class="metric-unit">°C</span></div>
                <div class="temp-secondary-val mono-num" id="weatherTempFVal">--.-°F</div>
              </div>
              <div class="metric-secondary-row">
                <span class="metric-secondary-item">
                  <span class="sec-label">Feels</span>
                  <strong class="mono-num" id="weatherTempFeelsVal">--.-°C</strong>
                </span>
                <span class="trend-indicator trend-steady" id="weatherTempTrend">
                  <span class="trend-arrow">→</span>
                  <span class="trend-label">Steady</span>
                </span>
              </div>
              <div class="metric-range-block">
                <div class="range-labels-row">
                  <span class="mono-num" id="weatherTempMinVal">--.-°C</span>
                  <span class="range-center-label">Today's High/Low</span>
                  <span class="mono-num" id="weatherTempMaxVal">--.-°C</span>
                </div>
                <div class="metric-track-with-marker" title="Today's Forecast Range">
                  <div class="range-fill-bar" id="weatherTempRangeFill" style="width: 50%; background-color: var(--chart-temp-line);"></div>
                  <div class="range-marker-pin" id="weatherTempMarkerPin" style="left: 50%;"></div>
                </div>
              </div>
            </div>
            <div class="card-sparkline-wrap" id="weatherTempSparklineWrap">
              <svg class="card-sparkline" id="weatherTempSparkline" viewBox="0 0 100 24" preserveAspectRatio="none"></svg>
            </div>
          </article>

          <!-- Card 2: API Atmospheric Humidity -->
          <article class="metric-card" id="cardWeatherHumidity">
            <div class="card-header">
              <span class="card-title">Humidity</span>
              <span class="card-badge badge-comfortable" id="weatherHumTag">Station</span>
            </div>
            <div class="card-body-content">
              <div class="humidity-dual-large">
                <div class="hum-col">
                  <div class="hum-val-row">
                    <span class="hum-large-val mono-num" id="weatherRhMainVal">--</span>
                    <span class="hum-large-unit">%</span>
                  </div>
                  <span class="hum-col-caption">Relative</span>
                </div>
                <div class="hum-divider"></div>
                <div class="hum-col">
                  <div class="hum-val-row">
                    <span class="hum-large-val mono-num" id="weatherAhMainVal">--.-</span>
                    <span class="hum-large-unit">g/m³</span>
                  </div>
                  <span class="hum-col-caption">Absolute</span>
                </div>
              </div>
              <div class="metric-secondary-row">
                <span class="metric-secondary-item">
                  <span class="sec-label">Zone</span>
                  <strong class="mono-num" id="weatherRhComfortDesc">Optimal Range</strong>
                </span>
              </div>
              <div class="metric-range-block">
                <div class="range-labels-row">
                  <span class="mono-num">0%</span>
                  <span class="range-zone-caption">30–60% Ideal</span>
                  <span class="mono-num">100%</span>
                </div>
                <div class="metric-track-with-marker humidity-track-with-comfort" title="Humidity Scale (30-60% optimal shaded)">
                  <div class="comfort-zone-shade" style="left: 30%; width: 30%;"></div>
                  <div class="range-marker-pin" id="weatherRhMarkerPin" style="left: 50%;"></div>
                </div>
              </div>
            </div>
            <div class="card-sparkline-wrap" id="weatherRhSparklineWrap">
              <svg class="card-sparkline" id="weatherRhSparkline" viewBox="0 0 100 24" preserveAspectRatio="none"></svg>
            </div>
          </article>

          <!-- Card 3: API Heat Index -->
          <article class="metric-card" id="cardWeatherHeatIndex">
            <div class="card-header">
              <span class="card-title">Heat Index</span>
              <span class="card-badge badge-normal" id="weatherHiBadge">Normal</span>
            </div>
            <div class="card-body-content">
              <div class="metric-main-value mono-num" id="weatherHiMainVal">--.-<span class="metric-unit">°C</span></div>
              <div class="metric-secondary-row">
                <span class="metric-secondary-item">
                  <strong class="mono-num" id="weatherHiDiffVal">+0.0°C vs air</strong>
                </span>
              </div>
              <div class="hi-scale-block">
                <div class="hi-marker-row">
                  <div class="hi-triangle-marker" id="weatherHiMarkerPin" style="left: 12.5%;"></div>
                </div>
                <div class="hi-four-segment-bar">
                  <div class="hi-seg hi-seg-normal"></div>
                  <div class="hi-seg hi-seg-caution"></div>
                  <div class="hi-seg hi-seg-extreme"></div>
                  <div class="hi-seg hi-seg-danger"></div>
                </div>
                <div class="hi-labels-row">
                  <span class="hi-lbl lbl-normal active" id="weatherHiLblNormal">Normal</span>
                  <span class="hi-lbl lbl-caution" id="weatherHiLblCaution">Caution</span>
                  <span class="hi-lbl lbl-extreme" id="weatherHiLblExtreme">Extreme</span>
                  <span class="hi-lbl lbl-danger" id="weatherHiLblDanger">Danger</span>
                </div>
              </div>
            </div>
            <div class="card-sparkline-wrap" id="weatherHiSparklineWrap">
              <svg class="card-sparkline" id="weatherHiSparkline" viewBox="0 0 100 24" preserveAspectRatio="none"></svg>
            </div>
          </article>

          <!-- Card 4: API Dew Point -->
          <article class="metric-card" id="cardWeatherDewPoint">
            <div class="card-header">
              <span class="card-title">Dew Point</span>
              <span class="card-badge badge-normal" id="weatherDpRiskBadge">Low Risk</span>
            </div>
            <div class="card-body-content">
              <div class="metric-main-value mono-num" id="weatherDpMainVal">--.-<span class="metric-unit">°C</span></div>
              <div class="metric-secondary-row">
                <span class="metric-secondary-item">
                  <strong class="mono-num" id="weatherDpSpreadVal">Spread --.-°C</strong>
                </span>
                <span class="comfort-word-badge" id="weatherDpComfortWord">Comfortable</span>
              </div>
              <div class="metric-range-block">
                <div class="range-labels-row">
                  <span class="mono-num">0°C</span>
                  <span class="range-center-label">Condensation</span>
                  <span class="mono-num">30°C</span>
                </div>
                <div class="metric-track-with-marker" title="Dew Point Scale">
                  <div class="range-fill-bar" id="weatherDpRangeFill" style="width: 50%; background-color: var(--accent-cyan);"></div>
                  <div class="range-marker-pin" id="weatherDpMarkerPin" style="left: 50%;"></div>
                </div>
              </div>
            </div>
            <div class="card-sparkline-wrap" id="weatherDpSparklineWrap">
              <svg class="card-sparkline" id="weatherDpSparkline" viewBox="0 0 100 24" preserveAspectRatio="none"></svg>
            </div>
          </article>
        </div>

        <!-- Slim Row of 4 Outdoor Meteorological Chips -->
        <div class="outdoor-chips-row" aria-label="Additional meteorological conditions">
          <div class="outdoor-chip">
            <span class="chip-label">Pressure</span>
            <span class="chip-val mono-num" id="outdoorPressureVal">-- hPa</span>
          </div>
          <div class="outdoor-chip">
            <span class="chip-label">Wind</span>
            <span class="chip-val mono-num" id="outdoorWindVal">-- km/h</span>
          </div>
          <div class="outdoor-chip">
            <span class="chip-label">UV Index</span>
            <span class="chip-val mono-num" id="outdoorUvVal">--</span>
          </div>
          <div class="outdoor-chip">
            <span class="chip-label">Rain Chance</span>
            <span class="chip-val mono-num" id="outdoorRainVal">--%</span>
          </div>
        </div>

        <!-- Weather API Diurnal Forecast Chart -->
        <article class="chart-card">
          <div class="chart-header">
            <div class="chart-titles">
              <h2>Outdoor (Open-Meteo)</h2>
            </div>
            <div class="chart-legend-custom">
              <span class="legend-item"><span class="legend-line" style="background-color: var(--chart-temp-line);"></span> API Temp (°C)</span>
              <span class="legend-item"><span class="legend-line" style="background-color: var(--chart-rh-line);"></span> API Humidity (%RH)</span>
            </div>
          </div>
          <div class="chart-container-wrapper">
            <canvas id="hourlyWeatherChart" aria-label="Hourly temperature and relative humidity forecast chart" role="img"></canvas>
          </div>
        </article>
      </section>

      <!-- ================================================================= -->
      <!-- SECTION 3: SENSOR VS. REAL WEATHER COMPARISON (BOTTOM SECTION)    -->
      <!-- ================================================================= -->
      <section class="section-block" aria-labelledby="secComparisonHeading">
        <div class="section-header-banner">
          <div class="section-header-info">
            <h2 id="secComparisonHeading" class="section-title">
              <span style="display: inline-flex; align-items: center; color: currentColor;">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/>
                  <path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/>
                  <path d="M7 21h10"/>
                  <path d="M12 3v18"/>
                  <path d="M3 7h18"/>
                </svg>
              </span>
              Divergence
            </h2>
          </div>
        </div>

        <!-- Delta Variance Cards -->
        <div class="delta-grid">
          <div class="delta-card">
            <span class="delta-card-label">Temperature Delta</span>
            <div class="delta-card-value mono-num" id="deltaTempVal">--.-°C</div>
          </div>

          <div class="delta-card">
            <span class="delta-card-label">Humidity Delta</span>
            <div class="delta-card-value mono-num" id="deltaRhVal">--% RH</div>
          </div>

          <div class="delta-card">
            <span class="delta-card-label">Divergence</span>
            <div class="delta-card-value mono-num" style="font-size: 1.05rem; color: var(--accent-sage);" id="deltaSyncStatus">Within DHT11 tolerance</div>
          </div>
        </div>

        <!-- Comparison Chart (Full Width) -->
        <article class="chart-card">
          <div class="chart-header">
            <div class="chart-titles">
              <h2>Divergence</h2>
            </div>
            <div class="chart-legend-custom">
              <span class="legend-item"><span class="legend-line dashed" style="border-color: var(--chart-ext-temp);"></span> Ext Temp (°C)</span>
              <span class="legend-item"><span class="legend-line dashed" style="border-color: var(--chart-ext-rh);"></span> Ext RH (%)</span>
              <span class="legend-item"><span class="legend-line" style="background-color: var(--chart-local-temp);"></span> Sensor Temp (°C)</span>
              <span class="legend-item"><span class="legend-line" style="background-color: var(--chart-local-rh);"></span> Sensor RH (%)</span>
            </div>
          </div>
          <div class="chart-container-wrapper">
            <canvas id="comparisonChart" aria-label="Comparison chart of external weather vs local sensor" role="img"></canvas>
          </div>
        </article>
      </section>
    `;

    this.bindEvents();
  }

  /**
   * Binds UI events.
   */
  bindEvents() {
    // 1. Location Dropdown
    const cityDropdown = this.container.querySelector("#cityDropdown");
    if (cityDropdown) {
      cityDropdown.addEventListener("change", (e) => {
        this.selectedCity = e.target.value;
        this.isAutoLocation = false;
        const autoBtn = this.container.querySelector("#autoLocationBtn");
        if (autoBtn) autoBtn.classList.remove("active");
        this.fetchWeatherData();
      });
    }

    // 2. Auto Location (Device GPS) Button
    const autoBtn = this.container.querySelector("#autoLocationBtn");
    if (autoBtn) {
      autoBtn.addEventListener("click", () => {
        this.detectDeviceLocation();
      });
    }

    // 3. Refresh Weather Button
    const refreshBtn = this.container.querySelector("#refreshWeatherBtn");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", () => {
        this.fetchWeatherData(true);
      });
    }

    // 4. Dismiss Hazard Alert
    const dismissHazardBtn = this.container.querySelector("#dismissHazardBtn");
    if (dismissHazardBtn) {
      dismissHazardBtn.addEventListener("click", () => {
        const banner = this.container.querySelector("#hazardAlertBanner");
        if (banner) banner.classList.add("hidden");
      });
    }

    // 5. Toggle Live Sensor Stream Button
    const toggleSensorBtn = this.container.querySelector("#toggleSensorStreamBtn");
    if (toggleSensorBtn) {
      toggleSensorBtn.addEventListener("click", () => {
        this.isStreamingActive = !this.isStreamingActive;
        toggleSensorBtn.setAttribute("aria-checked", this.isStreamingActive ? "true" : "false");
        const statusLabel = this.container.querySelector("#sensorStreamStatusLabel");
        if (this.isStreamingActive) {
          toggleSensorBtn.classList.add("is-streaming");
          toggleSensorBtn.classList.remove("is-paused");
          if (statusLabel) statusLabel.textContent = "Live Streaming";
        } else {
          toggleSensorBtn.classList.remove("is-streaming");
          toggleSensorBtn.classList.add("is-paused");
          if (statusLabel) statusLabel.textContent = "Stream Paused";
        }
      });
    }
  }

  /**
   * Uses HTML5 Geolocation to detect device GPS coordinates.
   * Gracefully falls back to manual dropdown on error or permission denial.
   */
  detectDeviceLocation() {
    const autoBtn = this.container.querySelector("#autoLocationBtn");
    const autoText = this.container.querySelector("#autoLocationText");

    if (!navigator.geolocation) {
      alert("Geolocation is not supported by your browser. Please select a station manually.");
      return;
    }

    if (autoBtn) autoBtn.classList.add("loading");
    if (autoText) autoText.textContent = "Detecting GPS...";

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        this.isAutoLocation = true;
        this.currentCoords = { lat, lon };

        if (autoBtn) {
          autoBtn.classList.remove("loading");
          autoBtn.classList.add("active");
        }
        if (autoText) autoText.textContent = "GPS Active";

        await this.fetchWeatherData(true);
      },
      (err) => {
        console.warn("Geolocation denied or unavailable:", err.message);
        this.isAutoLocation = false;
        if (autoBtn) {
          autoBtn.classList.remove("loading", "active");
        }
        if (autoText) autoText.textContent = "Auto (Device GPS)";

        const cityDropdown = this.container.querySelector("#cityDropdown");
        const defaultCity = cityDropdown ? cityDropdown.value : "Hasanparthy (Hanamkonda)";
        this.selectedCity = defaultCity;
        this.fetchWeatherData(true);
      },
      { timeout: 7000, enableHighAccuracy: false }
    );
  }

  /**
   * Fetches weather data for either detected GPS coordinates or selected city.
   */
  async fetchWeatherData(isManual = false) {
    const refreshBtn = this.container.querySelector("#refreshWeatherBtn");
    if (refreshBtn) refreshBtn.classList.add("spinning");

    try {
      let query;
      if (this.isAutoLocation && this.currentCoords) {
        query = { lat: this.currentCoords.lat, lon: this.currentCoords.lon };
      } else {
        query = this.selectedCity;
      }

      const data = await apiClient.getWeather(query);
      this.weatherData = data;
      this.updateWeatherUI(data);
      this.renderComparisonChart();
    } catch (err) {
      console.error("Failed to load weather data:", err);
    } finally {
      if (refreshBtn) {
        setTimeout(() => refreshBtn.classList.remove("spinning"), 400);
      }
    }
  }

  /**
   * Updates Section 1 (Sensor) UI elements.
   */
  updateSensorUI(reading) {
    const tempC = Number(reading.temperature_c);
    const humidityPct = Number(reading.humidity_pct);
    const feelsLikeC = reading.heat_index_c ?? calculateHeatIndex(tempC, humidityPct);
    const dewPointC = reading.dew_point_c ?? calculateDewPoint(tempC, humidityPct);
    const absHumidityGm3 = reading.absolute_humidity_gm3 ?? calculateAbsoluteHumidity(tempC, humidityPct);
    const heatIndexC = reading.heat_index_c ?? calculateHeatIndex(tempC, humidityPct);
    const tempF = celsiusToFahrenheit(tempC);

    // Track rolling history for sparklines & trend (~20 points)
    this.indoorTempHistory.push(tempC);
    this.indoorRhHistory.push(humidityPct);
    this.indoorHiHistory.push(heatIndexC);
    this.indoorDpHistory.push(dewPointC);
    if (this.indoorTempHistory.length > 20) this.indoorTempHistory.shift();
    if (this.indoorRhHistory.length > 20) this.indoorRhHistory.shift();
    if (this.indoorHiHistory.length > 20) this.indoorHiHistory.shift();
    if (this.indoorDpHistory.length > 20) this.indoorDpHistory.shift();

    // Session Min & Max temperature
    this.indoorMinTemp = Math.min(this.indoorMinTemp ?? tempC, tempC);
    this.indoorMaxTemp = Math.max(this.indoorMaxTemp ?? tempC, tempC);

    const hiCat = getHeatIndexCategory(heatIndexC);
    const dpCat = getDewPointComfortCategory(dewPointC);
    const humComfort = getHumidityComfort(humidityPct);
    const moldRisk = getMoldCondensationRisk(humidityPct, tempC - dewPointC);
    const dpDescriptor = getDewPointDescriptor(dewPointC);

    // Calculate trend from last ~20 readings
    const firstTemp = this.indoorTempHistory[0] ?? tempC;
    const tempDelta = tempC - firstTemp;
    let trendClass = "trend-steady";
    let trendArrow = "→";
    let trendText = "Steady";
    if (tempDelta > 0.2) {
      trendClass = "trend-rising";
      trendArrow = "↑";
      trendText = "Rising";
    } else if (tempDelta < -0.2) {
      trendClass = "trend-falling";
      trendArrow = "↓";
      trendText = "Falling";
    }

    const el = (id) => this.container.querySelector(id);

    // Badges in Header
    const packetBadge = el("#sensorPacketBadge");
    const rssiBadge = el("#sensorRssiBadge");
    if (packetBadge) packetBadge.textContent = `Packet: #${reading.packet_id}`;
    if (rssiBadge) {
      rssiBadge.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M5 12.55a11 11 0 0 1 14.08 0"/>
        <path d="M1.42 9a16 16 0 0 1 21.16 0"/>
        <path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>
        <line x1="12" y1="20" x2="12.01" y2="20"/>
      </svg><span>${reading.wifi_rssi_dbm || -64} dBm</span>`;
    }

    // --- Card 1: Temperature ---
    if (el("#sensorTempMainVal")) el("#sensorTempMainVal").innerHTML = `${tempC.toFixed(1)}<span class="metric-unit">°C</span>`;
    if (el("#sensorTempFVal")) el("#sensorTempFVal").textContent = `${tempF.toFixed(1)}°F`;
    if (el("#sensorTempFeelsVal")) el("#sensorTempFeelsVal").textContent = `${feelsLikeC.toFixed(1)}°C`;
    if (el("#sensorTempTrend")) {
      el("#sensorTempTrend").className = `trend-indicator ${trendClass}`;
      el("#sensorTempTrend").innerHTML = `<span class="trend-arrow">${trendArrow}</span> <span class="trend-label">${trendText}</span>`;
    }
    const minT = this.indoorMinTemp;
    const maxT = Math.max(this.indoorMaxTemp, minT + 0.1);
    const rangeSpanT = maxT - minT || 1.0;
    const tPinPct = Math.min(Math.max(((tempC - minT) / rangeSpanT) * 100, 2), 98);
    if (el("#sensorTempMinVal")) el("#sensorTempMinVal").textContent = `${minT.toFixed(1)}°C`;
    if (el("#sensorTempMaxVal")) el("#sensorTempMaxVal").textContent = `${maxT.toFixed(1)}°C`;
    if (el("#sensorTempRangeFill")) {
      el("#sensorTempRangeFill").style.width = `${tPinPct}%`;
    }
    if (el("#sensorTempMarkerPin")) {
      el("#sensorTempMarkerPin").style.left = `${tPinPct}%`;
    }
    if (el("#sensorTempSparkline")) {
      el("#sensorTempSparkline").innerHTML = generateSparklineSvg(this.indoorTempHistory, "var(--chart-local-temp)");
    }

    // --- Card 2: Humidity ---
    if (el("#sensorRhMainVal")) el("#sensorRhMainVal").textContent = `${Math.round(humidityPct)}`;
    if (el("#sensorAhMainVal")) el("#sensorAhMainVal").textContent = `${absHumidityGm3.toFixed(1)}`;
    if (el("#sensorHumTag")) {
      el("#sensorHumTag").className = `card-badge ${humComfort.colorClass}`;
      el("#sensorHumTag").textContent = humComfort.label;
    }
    if (el("#sensorRhComfortDesc")) {
      el("#sensorRhComfortDesc").textContent = humComfort.desc;
    }
    const rhPinPct = Math.min(Math.max(humidityPct, 1), 99);
    if (el("#sensorRhMarkerPin")) {
      el("#sensorRhMarkerPin").style.left = `${rhPinPct}%`;
    }
    if (el("#sensorRhSparkline")) {
      el("#sensorRhSparkline").innerHTML = generateSparklineSvg(this.indoorRhHistory, "var(--chart-local-rh)");
    }

    // --- Card 3: Heat Index ---
    if (el("#sensorHiMainVal")) el("#sensorHiMainVal").innerHTML = `${heatIndexC.toFixed(1)}<span class="metric-unit">°C</span>`;
    const hiDiff = heatIndexC - tempC;
    const hiDiffStr = `${hiDiff >= 0 ? "+" : ""}${hiDiff.toFixed(1)}°C vs air`;
    if (el("#sensorHiDiffVal")) el("#sensorHiDiffVal").textContent = hiDiffStr;
    if (el("#sensorHiBadge")) {
      el("#sensorHiBadge").className = `card-badge ${hiCat.colorClass}`;
      el("#sensorHiBadge").textContent = hiCat.label;
    }
    // Highlight active label: normal (<27), caution (27-32), extreme (32-41), danger (>41)
    const lblNormal = el("#sensorHiLblNormal");
    const lblCaution = el("#sensorHiLblCaution");
    const lblExtreme = el("#sensorHiLblExtreme");
    const lblDanger = el("#sensorHiLblDanger");
    const isNorm = heatIndexC < 27.0;
    const isCaut = heatIndexC >= 27.0 && heatIndexC < 32.0;
    const isExt = heatIndexC >= 32.0 && heatIndexC <= 41.0;
    const isDang = heatIndexC > 41.0;
    if (lblNormal) lblNormal.className = `hi-lbl lbl-normal ${isNorm ? "active" : ""}`;
    if (lblCaution) lblCaution.className = `hi-lbl lbl-caution ${isCaut ? "active" : ""}`;
    if (lblExtreme) lblExtreme.className = `hi-lbl lbl-extreme ${isExt ? "active" : ""}`;
    if (lblDanger) lblDanger.className = `hi-lbl lbl-danger ${isDang ? "active" : ""}`;
    // Triangle marker positioned at active segment center
    let hiPinPct = 12.5;
    if (isNorm) {
      hiPinPct = 12.5;
    } else if (isCaut) {
      hiPinPct = 37.5;
    } else if (isExt) {
      hiPinPct = 62.5;
    } else {
      hiPinPct = 87.5;
    }
    if (el("#sensorHiMarkerPin")) {
      el("#sensorHiMarkerPin").style.left = `${hiPinPct}%`;
    }
    if (el("#sensorHiSparkline")) {
      el("#sensorHiSparkline").innerHTML = generateSparklineSvg(this.indoorHiHistory, "var(--accent-amber)");
    }

    // --- Card 4: Dew Point ---
    if (el("#sensorDpMainVal")) el("#sensorDpMainVal").innerHTML = `${dewPointC.toFixed(1)}<span class="metric-unit">°C</span>`;
    const dpSpread = tempC - dewPointC;
    if (el("#sensorDpSpreadVal")) el("#sensorDpSpreadVal").textContent = `Spread ${dpSpread.toFixed(1)}°C`;
    if (el("#sensorDpComfortWord")) el("#sensorDpComfortWord").textContent = dpDescriptor;
    if (el("#sensorDpRiskBadge")) {
      el("#sensorDpRiskBadge").className = `card-badge ${moldRisk.colorClass}`;
      el("#sensorDpRiskBadge").textContent = moldRisk.label;
    }
    // Pin on 0-30°C scale
    const dpPinPct = Math.min(Math.max(((dewPointC - 0) / 30) * 100, 2), 98);
    if (el("#sensorDpRangeFill")) {
      el("#sensorDpRangeFill").style.width = `${dpPinPct}%`;
    }
    if (el("#sensorDpMarkerPin")) {
      el("#sensorDpMarkerPin").style.left = `${dpPinPct}%`;
    }
    if (el("#sensorDpSparkline")) {
      el("#sensorDpSparkline").innerHTML = generateSparklineSvg(this.indoorDpHistory, "var(--accent-cyan)");
    }

    // Check Hazard Alerts
    this.evaluateHazardAlert(heatIndexC, humidityPct, "Sensor Node");
  }

  /**
   * Updates Section 2 (Weather API) UI elements.
   */
  updateWeatherUI(data) {
    const current = data.current || {};
    const hourly = data.hourly || {};
    const daily = data.daily || {};

    const tempC = Number(current.temperature_2m ?? 28.0);
    const humidityPct = Number(current.relative_humidity_2m ?? 60.0);
    const feelsLikeC = Number(current.apparent_temperature ?? current.heat_index_c ?? tempC);

    const dewPointC = Number(current.dew_point_c ?? calculateDewPoint(tempC, humidityPct));
    const absHumidityGm3 = Number(current.absolute_humidity_gm3 ?? calculateAbsoluteHumidity(tempC, humidityPct));
    const heatIndexC = Number(current.heat_index_c ?? calculateHeatIndex(tempC, humidityPct));
    const tempF = celsiusToFahrenheit(tempC);

    const hiCat = getHeatIndexCategory(heatIndexC);
    const humComfort = getHumidityComfort(humidityPct);
    const moldRisk = getMoldCondensationRisk(humidityPct, tempC - dewPointC);
    const dpDescriptor = getDewPointDescriptor(dewPointC);

    // Weather forecast trend from next hour in hourly data
    let trendClass = "trend-steady";
    let trendArrow = "→";
    let trendText = "Steady";
    if (hourly.temperature_2m && hourly.temperature_2m.length > 1) {
      const nextHourTemp = Number(hourly.temperature_2m[1]);
      const diff = nextHourTemp - tempC;
      if (diff > 0.2) {
        trendClass = "trend-rising";
        trendArrow = "↑";
        trendText = "Rising";
      } else if (diff < -0.2) {
        trendClass = "trend-falling";
        trendArrow = "↓";
        trendText = "Falling";
      }
    }

    // Daily High & Low from API
    let minT = daily.temperature_2m_min != null ? (Array.isArray(daily.temperature_2m_min) ? Number(daily.temperature_2m_min[0]) : Number(daily.temperature_2m_min)) : (tempC - 4);
    let maxT = daily.temperature_2m_max != null ? (Array.isArray(daily.temperature_2m_max) ? Number(daily.temperature_2m_max[0]) : Number(daily.temperature_2m_max)) : (tempC + 4);
    if (minT === maxT) {
      minT -= 1;
      maxT += 1;
    }
    const tPinPct = Math.min(Math.max(((tempC - minT) / (maxT - minT)) * 100, 2), 98);

    const el = (id) => this.container.querySelector(id);

    // Coordinates Badge & Last Updated
    const coordsBadge = el("#locationCoordsBadge");
    if (coordsBadge) {
      if (this.isAutoLocation && this.currentCoords) {
        coordsBadge.textContent = `GPS: ${this.currentCoords.lat.toFixed(4)}°N • ${this.currentCoords.lon.toFixed(4)}°E`;
      } else if (data.pin_code && data.coordinates_dms) {
        coordsBadge.textContent = `PIN: ${data.pin_code} • ${data.coordinates_dms}`;
      } else if (data.coordinates) {
        coordsBadge.textContent = `Lat: ${data.coordinates.latitude}°N • Lon: ${data.coordinates.longitude}°E`;
      }
    }
    const lastUpdatedLabel = el("#lastUpdatedLabel");
    if (lastUpdatedLabel) {
      lastUpdatedLabel.textContent = `Updated: ${format24Time()}`;
    }

    // --- Weather Card 1: Temperature ---
    if (el("#weatherTempMainVal")) el("#weatherTempMainVal").innerHTML = `${tempC.toFixed(1)}<span class="metric-unit">°C</span>`;
    if (el("#weatherTempFVal")) el("#weatherTempFVal").textContent = `${tempF.toFixed(1)}°F`;
    if (el("#weatherTempFeelsVal")) el("#weatherTempFeelsVal").textContent = `${feelsLikeC.toFixed(1)}°C`;
    if (el("#weatherTempTrend")) {
      el("#weatherTempTrend").className = `trend-indicator ${trendClass}`;
      el("#weatherTempTrend").innerHTML = `<span class="trend-arrow">${trendArrow}</span> <span class="trend-label">${trendText}</span>`;
    }
    if (el("#weatherTempMinVal")) el("#weatherTempMinVal").textContent = `${minT.toFixed(1)}°C`;
    if (el("#weatherTempMaxVal")) el("#weatherTempMaxVal").textContent = `${maxT.toFixed(1)}°C`;
    if (el("#weatherTempRangeFill")) el("#weatherTempRangeFill").style.width = `${tPinPct}%`;
    if (el("#weatherTempMarkerPin")) el("#weatherTempMarkerPin").style.left = `${tPinPct}%`;
    const hourlyTemps = hourly.temperature_2m ? hourly.temperature_2m.slice(0, 20) : [tempC];
    if (el("#weatherTempSparkline")) {
      el("#weatherTempSparkline").innerHTML = generateSparklineSvg(hourlyTemps, "var(--chart-temp-line)");
    }

    // --- Weather Card 2: Humidity ---
    if (el("#weatherRhMainVal")) el("#weatherRhMainVal").textContent = `${Math.round(humidityPct)}`;
    if (el("#weatherAhMainVal")) el("#weatherAhMainVal").textContent = `${absHumidityGm3.toFixed(1)}`;
    if (el("#weatherHumTag")) {
      el("#weatherHumTag").className = `card-badge ${humComfort.colorClass}`;
      el("#weatherHumTag").textContent = humComfort.label;
    }
    if (el("#weatherRhComfortDesc")) {
      el("#weatherRhComfortDesc").textContent = humComfort.desc;
    }
    const rhPinPct = Math.min(Math.max(humidityPct, 1), 99);
    if (el("#weatherRhMarkerPin")) el("#weatherRhMarkerPin").style.left = `${rhPinPct}%`;
    const hourlyRhs = hourly.relative_humidity_2m ? hourly.relative_humidity_2m.slice(0, 20) : [humidityPct];
    if (el("#weatherRhSparkline")) {
      el("#weatherRhSparkline").innerHTML = generateSparklineSvg(hourlyRhs, "var(--chart-rh-line)");
    }

    // --- Weather Card 3: Heat Index ---
    if (el("#weatherHiMainVal")) el("#weatherHiMainVal").innerHTML = `${heatIndexC.toFixed(1)}<span class="metric-unit">°C</span>`;
    const hiDiff = heatIndexC - tempC;
    const hiDiffStr = `${hiDiff >= 0 ? "+" : ""}${hiDiff.toFixed(1)}°C vs air`;
    if (el("#weatherHiDiffVal")) el("#weatherHiDiffVal").textContent = hiDiffStr;
    if (el("#weatherHiBadge")) {
      el("#weatherHiBadge").className = `card-badge ${hiCat.colorClass}`;
      el("#weatherHiBadge").textContent = hiCat.label;
    }
    const wLblNormal = el("#weatherHiLblNormal");
    const wLblCaution = el("#weatherHiLblCaution");
    const wLblExtreme = el("#weatherHiLblExtreme");
    const wLblDanger = el("#weatherHiLblDanger");
    const wIsNorm = heatIndexC < 27.0;
    const wIsCaut = heatIndexC >= 27.0 && heatIndexC < 32.0;
    const wIsExt = heatIndexC >= 32.0 && heatIndexC <= 41.0;
    const wIsDang = heatIndexC > 41.0;
    if (wLblNormal) wLblNormal.className = `hi-lbl lbl-normal ${wIsNorm ? "active" : ""}`;
    if (wLblCaution) wLblCaution.className = `hi-lbl lbl-caution ${wIsCaut ? "active" : ""}`;
    if (wLblExtreme) wLblExtreme.className = `hi-lbl lbl-extreme ${wIsExt ? "active" : ""}`;
    if (wLblDanger) wLblDanger.className = `hi-lbl lbl-danger ${wIsDang ? "active" : ""}`;
    let wHiPinPct = 12.5;
    if (wIsNorm) {
      wHiPinPct = 12.5;
    } else if (wIsCaut) {
      wHiPinPct = 37.5;
    } else if (wIsExt) {
      wHiPinPct = 62.5;
    } else {
      wHiPinPct = 87.5;
    }
    if (el("#weatherHiMarkerPin")) el("#weatherHiMarkerPin").style.left = `${wHiPinPct}%`;
    // Compute hourly heat indexes for sparkline
    const hourlyHis = hourlyTemps.map((t, idx) => {
      const rh = hourlyRhs[idx] ?? humidityPct;
      return calculateHeatIndex(t, rh);
    });
    if (el("#weatherHiSparkline")) {
      el("#weatherHiSparkline").innerHTML = generateSparklineSvg(hourlyHis, "var(--accent-amber)");
    }

    // --- Weather Card 4: Dew Point ---
    if (el("#weatherDpMainVal")) el("#weatherDpMainVal").innerHTML = `${dewPointC.toFixed(1)}<span class="metric-unit">°C</span>`;
    const dpSpread = tempC - dewPointC;
    if (el("#weatherDpSpreadVal")) el("#weatherDpSpreadVal").textContent = `Spread ${dpSpread.toFixed(1)}°C`;
    if (el("#weatherDpComfortWord")) el("#weatherDpComfortWord").textContent = dpDescriptor;
    if (el("#weatherDpRiskBadge")) {
      el("#weatherDpRiskBadge").className = `card-badge ${moldRisk.colorClass}`;
      el("#weatherDpRiskBadge").textContent = moldRisk.label;
    }
    const wDpPinPct = Math.min(Math.max(((dewPointC - 0) / 30) * 100, 2), 98);
    if (el("#weatherDpRangeFill")) el("#weatherDpRangeFill").style.width = `${wDpPinPct}%`;
    if (el("#weatherDpMarkerPin")) el("#weatherDpMarkerPin").style.left = `${wDpPinPct}%`;
    const hourlyDps = hourlyTemps.map((t, idx) => {
      const rh = hourlyRhs[idx] ?? humidityPct;
      return calculateDewPoint(t, rh);
    });
    if (el("#weatherDpSparkline")) {
      el("#weatherDpSparkline").innerHTML = generateSparklineSvg(hourlyDps, "var(--accent-cyan)");
    }

    // --- Slim Row of 4 Outdoor Meteorological Chips ---
    const pressure = Number(current.pressure_msl ?? 1013.2);
    const windSpeed = Number(current.wind_speed_10m ?? 0.0);
    const uvVal = hourly.uv_index && hourly.uv_index.length ? Number(hourly.uv_index[0]) : 0.0;
    const uvCat = uvVal >= 11 ? "Ext" : uvVal >= 8 ? "V.High" : uvVal >= 6 ? "High" : uvVal >= 3 ? "Mod" : "Low";
    const rainChance = hourly.precipitation_probability && hourly.precipitation_probability.length ? Number(hourly.precipitation_probability[0]) : 0;

    if (el("#outdoorPressureVal")) el("#outdoorPressureVal").textContent = `${Math.round(pressure)} hPa`;
    if (el("#outdoorWindVal")) el("#outdoorWindVal").textContent = `${windSpeed.toFixed(1)} km/h`;
    if (el("#outdoorUvVal")) el("#outdoorUvVal").textContent = `${uvVal.toFixed(1)} ${uvCat}`;
    if (el("#outdoorRainVal")) el("#outdoorRainVal").textContent = `${Math.round(rainChance)}%`;

    // Render 24h Diurnal Chart
    this.renderWeatherChart(data.hourly);
  }

  /**
   * Evaluates hazard alert banner based on sensor or external weather readings.
   */
  evaluateHazardAlert(heatIndexC, humidityPct, source) {
    const banner = this.container.querySelector("#hazardAlertBanner");
    const bannerTitle = this.container.querySelector("#hazardAlertTitle");
    const bannerDesc = this.container.querySelector("#hazardAlertDesc");
    if (!banner || !bannerTitle || !bannerDesc) return;

    if (heatIndexC > 41.0 || humidityPct > 80.0) {
      banner.classList.remove("hidden");
      if (heatIndexC > 41.0 && humidityPct > 80.0) {
        bannerTitle.textContent = `${source} Critical Alert: Heat Index ${heatIndexC.toFixed(1)}°C & Humidity ${Math.round(humidityPct)}%`;
        bannerDesc.textContent = `High risk of heat exhaustion and severe saturation. Limit physical exposure.`;
      } else if (heatIndexC > 41.0) {
        bannerTitle.textContent = `${source} Heat Alert: Heat Index ${heatIndexC.toFixed(1)}°C Exceeds 41°C`;
        bannerDesc.textContent = `Rothfusz danger threshold breached. Prolonged exposure carries high heat stroke risk.`;
      } else {
        bannerTitle.textContent = `${source} High Humidity Alert: Relative Humidity ${Math.round(humidityPct)}% Exceeds 80%`;
        bannerDesc.textContent = `Moisture saturation reduces evaporative cooling and promotes condensation.`;
      }
    } else {
      banner.classList.add("hidden");
    }
  }

  /**
   * Initializes Section 1: Sensor Real-Time Telemetry Chart once.
   * Animation is strictly disabled to prevent entry animation replay on live ticks.
   */
  initSensorChart() {
    if (typeof Chart === "undefined") return;
    const ctx = this.container.querySelector("#sensorTelemetryChart");
    if (!ctx) return;

    if (this.sensorChart) {
      this.sensorChart.destroy();
      this.sensorChart = null;
    }

    const isDarkMode = document.documentElement.getAttribute("data-theme") === "dark";
    const gridColor = isDarkMode ? "rgba(233, 235, 238, 0.06)" : "rgba(27, 25, 22, 0.08)";
    const textColor = isDarkMode ? "#9aa1ab" : "#5e5950";
    const tempColor = isDarkMode ? "#fb923c" : "#ea580c";
    const rhColor = isDarkMode ? "#4ade80" : "#167a3f";

    this.sensorChart = new Chart(ctx, {
      type: "line",
      data: {
        labels: [],
        datasets: [
          {
            label: "Sensor Temp (°C)",
            data: [],
            borderColor: tempColor,
            backgroundColor: (c) => getVerticalGradient(c, tempColor, isDarkMode ? 0.18 : 0.22),
            borderWidth: 2,
            fill: true,
            tension: 0.25,
            yAxisID: "yTemp",
            pointRadius: 2.5,
            pointHoverRadius: 5,
            pointBackgroundColor: tempColor,
            pointBorderColor: isDarkMode ? "#171a1f" : "#ffffff",
          },
          {
            label: "Sensor RH (%RH)",
            data: [],
            borderColor: rhColor,
            borderWidth: 2,
            fill: false,
            tension: 0.25,
            yAxisID: "yHumidity",
            pointRadius: 2.5,
            pointHoverRadius: 5,
            pointBackgroundColor: rhColor,
            pointBorderColor: isDarkMode ? "#171a1f" : "#ffffff",
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: isDarkMode ? "#171a1f" : "#ffffff",
            titleColor: isDarkMode ? "#e9ebee" : "#1b1916",
            bodyColor: isDarkMode ? "#9aa1ab" : "#5e5950",
            borderColor: isDarkMode ? "#e9ebee" : "#1b1916",
            borderWidth: 2,
            padding: 8,
            cornerRadius: 6,
            titleFont: { family: "'Space Grotesk', sans-serif", weight: 600, size: 12 },
            bodyFont: { family: "'IBM Plex Mono', monospace", size: 11 },
          },
        },
        scales: {
          x: {
            grid: { color: gridColor },
            ticks: {
              color: textColor,
              font: { family: "'IBM Plex Mono', monospace", size: 10 },
              maxTicksLimit: 6,
            },
          },
          yTemp: {
            type: "linear",
            position: "left",
            suggestedMin: 25,
            suggestedMax: 30,
            title: {
              display: true,
              text: "Temperature (°C)",
              color: tempColor,
              font: { family: "'Space Grotesk', sans-serif", weight: 600, size: 11 },
            },
            grid: { color: gridColor },
            ticks: {
              color: textColor,
              font: { family: "'IBM Plex Mono', monospace", size: 10 },
            },
          },
          yHumidity: {
            type: "linear",
            position: "right",
            title: {
              display: true,
              text: "Relative Humidity (%)",
              color: rhColor,
              font: { family: "'Space Grotesk', sans-serif", weight: 600, size: 11 },
            },
            grid: { drawOnChartArea: false },
            ticks: {
              color: textColor,
              font: { family: "'IBM Plex Mono', monospace", size: 10 },
            },
            min: 0,
            max: 100,
          },
        },
      },
    });
  }

  /**
   * Updates Section 1 Sensor Chart data in place with chart.update('none').
   */
  updateSensorChart() {
    const emptyState = this.container.querySelector("#sensorChartEmptyState");
    if (emptyState) {
      emptyState.classList.toggle("hidden", this.sensorHistory.length > 0);
    }

    if (!this.sensorChart) {
      this.initSensorChart();
      if (!this.sensorChart) return;
    }

    const isDarkMode = document.documentElement.getAttribute("data-theme") === "dark";
    const tempColor = isDarkMode ? "#fb923c" : "#ea580c";
    const rhColor = isDarkMode ? "#4ade80" : "#167a3f";

    const labels = this.sensorHistory.map((pt) => pt.time);
    const tempData = this.sensorHistory.map((pt) => pt.temperature_c);
    const rhData = this.sensorHistory.map((pt) => pt.humidity_pct);

    const minST = tempData.length ? Math.min(...tempData) : 25;
    const maxST = tempData.length ? Math.max(...tempData) : 30;
    const spanST = maxST - minST;
    const padST = spanST < 5.0 ? (5.0 - spanST) / 2 : 1.0;
    const yTempMin = Math.floor(minST - padST);
    const yTempMax = Math.ceil(maxST + padST);

    this.sensorChart.data.labels = labels;
    this.sensorChart.data.datasets[0].data = tempData;
    this.sensorChart.data.datasets[0].borderColor = tempColor;
    this.sensorChart.data.datasets[0].backgroundColor = (c) =>
      getVerticalGradient(c, tempColor, isDarkMode ? 0.18 : 0.22);
    this.sensorChart.data.datasets[0].pointBackgroundColor = tempColor;
    this.sensorChart.data.datasets[0].pointBorderColor = isDarkMode ? "#171a1f" : "#ffffff";

    this.sensorChart.data.datasets[1].data = rhData;
    this.sensorChart.data.datasets[1].borderColor = rhColor;
    this.sensorChart.data.datasets[1].pointBackgroundColor = rhColor;
    this.sensorChart.data.datasets[1].pointBorderColor = isDarkMode ? "#171a1f" : "#ffffff";

    this.sensorChart.options.scales.yTemp.suggestedMin = yTempMin;
    this.sensorChart.options.scales.yTemp.suggestedMax = yTempMax;
    this.sensorChart.update("none");
  }

  renderSensorChart() {
    this.initSensorChart();
    this.updateSensorChart();
  }

  /**
   * Renders Section 2: Weather API 24-Hour Diurnal Chart.
   */
  renderWeatherChart(hourly) {
    if (!hourly || !hourly.time) return;
    if (typeof Chart === "undefined") return;

    const ctx = this.container.querySelector("#hourlyWeatherChart");
    if (!ctx) return;

    // Ensure labels are formatted as strict HH:MM
    const labels = hourly.time.map((t) => {
      if (typeof t === "string") {
        if (t.includes("T")) return t.split("T")[1].slice(0, 5);
        if (t.length > 5 && t.includes(":")) return t.slice(-5);
        return t;
      }
      return String(t);
    });
    const tempData = hourly.temperature_2m;
    const rhData = hourly.relative_humidity_2m;

    const currentHour = new Date().getHours();
    const pointRadii = labels.map((_, idx) => (idx === currentHour ? 5 : 2.5));
    const pointHoverRadii = labels.map((_, idx) => (idx === currentHour ? 7 : 4.5));
    const isDarkMode = document.documentElement.getAttribute("data-theme") === "dark";
    const gridColor = isDarkMode ? "rgba(233, 235, 238, 0.06)" : "rgba(27, 25, 22, 0.08)";
    const textColor = isDarkMode ? "#9aa1ab" : "#5e5950";
    const tempColor = isDarkMode ? "#fa6a45" : "#d94b26";
    const rhColor = isDarkMode ? "#38bdf8" : "#0284c7";

    const pointBackgrounds = labels.map((_, idx) =>
      idx === currentHour ? (isDarkMode ? "#e9ebee" : "#1b1916") : tempColor
    );

    if (this.weatherChart) {
      this.weatherChart.destroy();
    }

    this.weatherChart = new Chart(ctx, {
      type: "line",
      data: {
        labels: labels,
        datasets: [
          {
            label: "API Temp (°C)",
            data: tempData,
            borderColor: tempColor,
            backgroundColor: (c) => getVerticalGradient(c, tempColor, isDarkMode ? 0.18 : 0.22),
            borderWidth: 2,
            fill: true,
            tension: 0.35,
            yAxisID: "yTemp",
            pointRadius: pointRadii,
            pointHoverRadius: pointHoverRadii,
            pointBackgroundColor: pointBackgrounds,
            pointBorderWidth: 1.5,
            pointBorderColor: isDarkMode ? "#171a1f" : "#ffffff",
          },
          {
            label: "API Humidity (%RH)",
            data: rhData,
            borderColor: rhColor,
            borderWidth: 2,
            fill: false,
            tension: 0.35,
            yAxisID: "yHumidity",
            pointRadius: 2.5,
            pointHoverRadius: 4.5,
            pointBackgroundColor: rhColor,
            pointBorderColor: isDarkMode ? "#171a1f" : "#ffffff",
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: isDarkMode ? "#171a1f" : "#ffffff",
            titleColor: isDarkMode ? "#e9ebee" : "#1b1916",
            bodyColor: isDarkMode ? "#9aa1ab" : "#5e5950",
            borderColor: isDarkMode ? "#e9ebee" : "#1b1916",
            borderWidth: 2,
            padding: 8,
            cornerRadius: 6,
            titleFont: { family: "'Space Grotesk', sans-serif", weight: 600, size: 12 },
            bodyFont: { family: "'IBM Plex Mono', monospace", size: 11 },
            callbacks: {
              title: (items) => {
                const hourIdx = items[0]?.dataIndex;
                const prefix = hourIdx === currentHour ? "★ Current Hour (" : "Hour (";
                return `${prefix}${items[0]?.label})`;
              },
            },
          },
        },
        scales: {
          x: {
            grid: { color: gridColor },
            ticks: {
              color: textColor,
              font: { family: "'IBM Plex Mono', monospace", size: 10 },
              callback: function (val, index) {
                return index % 4 === 0 ? this.getLabelForValue(val) : "";
              },
            },
          },
          yTemp: {
            type: "linear",
            position: "left",
            title: {
              display: true,
              text: "Temperature (°C)",
              color: tempColor,
              font: { family: "'Space Grotesk', sans-serif", weight: 600, size: 11 },
            },
            grid: { color: gridColor },
            ticks: {
              color: textColor,
              font: { family: "'IBM Plex Mono', monospace", size: 10 },
            },
          },
          yHumidity: {
            type: "linear",
            position: "right",
            title: {
              display: true,
              text: "Relative Humidity (%)",
              color: rhColor,
              font: { family: "'Space Grotesk', sans-serif", weight: 600, size: 11 },
            },
            grid: { drawOnChartArea: false },
            ticks: {
              color: textColor,
              font: { family: "'IBM Plex Mono', monospace", size: 10 },
            },
            min: 0,
            max: 100,
          },
        },
      },
    });
  }

  /**
   * Updates Section 3 Delta variance cards and divergence status badge.
   */
  updateDeltaCards() {
    const sensorReading = this.latestSensorReading;
    const weatherCurrent = this.weatherData?.current;

    if (sensorReading && weatherCurrent) {
      const sTemp = sensorReading.temperature_c;
      const wTemp = weatherCurrent.temperature_2m;
      const sRh = sensorReading.humidity_pct;
      const wRh = weatherCurrent.relative_humidity_2m;

      const diffTemp = sTemp - wTemp;
      const diffRh = sRh - wRh;

      const deltaTempVal = this.container.querySelector("#deltaTempVal");
      const deltaTempSub = this.container.querySelector("#deltaTempSub");
      const deltaRhVal = this.container.querySelector("#deltaRhVal");
      const deltaRhSub = this.container.querySelector("#deltaRhSub");

      if (deltaTempVal) {
        deltaTempVal.textContent = `${diffTemp >= 0 ? "+" : ""}${diffTemp.toFixed(1)}°C`;
        deltaTempVal.style.color = diffTemp > 0 ? "var(--accent-terracotta)" : "var(--accent-cyan)";
      }
      if (deltaTempSub) {
        deltaTempSub.textContent = diffTemp > 0 ? "Sensor reads warmer (Indoor/Enclosure offset)" : "Sensor reads cooler than regional API";
      }

      if (deltaRhVal) {
        deltaRhVal.textContent = `${diffRh >= 0 ? "+" : ""}${Math.round(diffRh)}% RH`;
        deltaRhVal.style.color = Math.abs(diffRh) < 10 ? "var(--accent-sage)" : "var(--accent-amber)";
      }
      if (deltaRhSub) {
        deltaRhSub.textContent = Math.abs(diffRh) < 8 ? "Tightly correlated with regional moisture" : "Local localized humidity divergence";
      }

      // Requirement 5: Indoor vs outdoor divergence badge logic
      const deltaSyncStatus = this.container.querySelector("#deltaSyncStatus");
      const deltaSyncSub = this.container.querySelector("#deltaSyncSub");
      const withinTolerance = Math.abs(diffTemp) <= 2.0 && Math.abs(diffRh) <= 5.0;

      if (deltaSyncStatus) {
        if (withinTolerance) {
          deltaSyncStatus.textContent = "Within DHT11 tolerance";
          deltaSyncStatus.style.color = "var(--accent-sage)";
          if (deltaSyncSub) deltaSyncSub.textContent = `ΔT ${Math.abs(diffTemp).toFixed(1)}°C ≤ ±2°C • ΔRH ${Math.abs(diffRh).toFixed(0)}% ≤ ±5%`;
        } else {
          deltaSyncStatus.textContent = "Expected local microclimate difference";
          deltaSyncStatus.style.color = "var(--accent-amber)";
          if (deltaSyncSub) deltaSyncSub.textContent = `ΔT ${Math.abs(diffTemp).toFixed(1)}°C • ΔRH ${Math.abs(diffRh).toFixed(0)}% outside tolerance`;
        }
      }
    }
  }

  /**
   * Initializes Section 3 Comparison Chart once.
   * Animation is strictly disabled to prevent entry animation replay on live ticks.
   */
  initComparisonChart() {
    if (typeof Chart === "undefined") return;
    const ctx = this.container.querySelector("#comparisonChart");
    if (!ctx) return;

    if (this.comparisonChart) {
      this.comparisonChart.destroy();
      this.comparisonChart = null;
    }

    const isDarkMode = document.documentElement.getAttribute("data-theme") === "dark";
    const gridColor = isDarkMode ? "rgba(233, 235, 238, 0.06)" : "rgba(27, 25, 22, 0.08)";
    const textColor = isDarkMode ? "#9aa1ab" : "#5e5950";

    const extTempColor = isDarkMode ? "#fdba74" : "#f97316";
    const extRhColor = isDarkMode ? "#7dd3fc" : "#0ea5e9";
    const sensorTempColor = isDarkMode ? "#fb923c" : "#ea580c";
    const sensorRhColor = isDarkMode ? "#4ade80" : "#167a3f";

    this.comparisonChart = new Chart(ctx, {
      type: "line",
      data: {
        labels: [],
        datasets: [
          {
            label: "Ext Weather Temp (°C)",
            data: [],
            borderColor: extTempColor,
            borderDash: [6, 4],
            borderWidth: 2,
            fill: false,
            pointRadius: 0,
            pointHoverRadius: 0,
            yAxisID: "yTemp",
          },
          {
            label: "Ext Weather RH (%)",
            data: [],
            borderColor: extRhColor,
            borderDash: [6, 4],
            borderWidth: 2,
            fill: false,
            pointRadius: 0,
            pointHoverRadius: 0,
            yAxisID: "yRH",
          },
          {
            label: "Sensor DHT11 Temp (°C)",
            data: [],
            borderColor: sensorTempColor,
            borderWidth: 2,
            fill: false,
            pointRadius: 2.5,
            pointHoverRadius: 5,
            pointBackgroundColor: sensorTempColor,
            pointBorderColor: isDarkMode ? "#171a1f" : "#ffffff",
            yAxisID: "yTemp",
            tension: 0.2,
          },
          {
            label: "Sensor DHT11 RH (%)",
            data: [],
            borderColor: sensorRhColor,
            borderWidth: 2,
            fill: false,
            pointRadius: 2.5,
            pointHoverRadius: 5,
            pointBackgroundColor: sensorRhColor,
            pointBorderColor: isDarkMode ? "#171a1f" : "#ffffff",
            yAxisID: "yRH",
            tension: 0.2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: isDarkMode ? "#171a1f" : "#ffffff",
            titleColor: isDarkMode ? "#e9ebee" : "#1b1916",
            bodyColor: isDarkMode ? "#9aa1ab" : "#5e5950",
            borderColor: isDarkMode ? "#e9ebee" : "#1b1916",
            borderWidth: 2,
            padding: 8,
            cornerRadius: 6,
            titleFont: { family: "'Space Grotesk', sans-serif", weight: 600, size: 12 },
            bodyFont: { family: "'IBM Plex Mono', monospace", size: 11 },
          },
        },
        scales: {
          x: {
            grid: { color: gridColor },
            ticks: {
              color: textColor,
              font: { family: "'IBM Plex Mono', monospace", size: 10 },
              maxTicksLimit: 6,
            },
          },
          yTemp: {
            type: "linear",
            position: "left",
            suggestedMin: 25,
            suggestedMax: 35,
            title: {
              display: true,
              text: "Temperature (°C)",
              color: sensorTempColor,
              font: { family: "'Space Grotesk', sans-serif", weight: 600, size: 11 },
            },
            grid: { color: gridColor },
            ticks: {
              color: textColor,
              font: { family: "'IBM Plex Mono', monospace", size: 10 },
            },
          },
          yRH: {
            type: "linear",
            position: "right",
            title: {
              display: true,
              text: "Relative Humidity (%)",
              color: sensorRhColor,
              font: { family: "'Space Grotesk', sans-serif", weight: 600, size: 11 },
            },
            grid: { drawOnChartArea: false },
            ticks: {
              color: textColor,
              font: { family: "'IBM Plex Mono', monospace", size: 10 },
            },
            min: 0,
            max: 100,
          },
        },
      },
    });
  }

  /**
   * Updates Section 3 Comparison Chart in place with chart.update('none').
   */
  updateComparisonChart() {
    if (!this.comparisonChart) {
      this.initComparisonChart();
      if (!this.comparisonChart) return;
    }

    const isDarkMode = document.documentElement.getAttribute("data-theme") === "dark";
    const extTempColor = isDarkMode ? "#fdba74" : "#f97316";
    const extRhColor = isDarkMode ? "#7dd3fc" : "#0ea5e9";
    const sensorTempColor = isDarkMode ? "#fb923c" : "#ea580c";
    const sensorRhColor = isDarkMode ? "#4ade80" : "#167a3f";

    const weatherCurrent = this.weatherData?.current;
    const labels = this.sensorHistory.map((pt) => pt.time);
    const extTemp = weatherCurrent?.temperature_2m ?? 31.8;
    const extRh = weatherCurrent?.relative_humidity_2m ?? 48.0;

    const extTempArr = labels.map(() => extTemp);
    const extRhArr = labels.map(() => extRh);
    const localTempArr = this.sensorHistory.map((p) => p.temperature_c);
    const localRhArr = this.sensorHistory.map((p) => p.humidity_pct);

    // Enforce minimum 5°C span for comparison chart
    const allCompTemps = [...extTempArr, ...localTempArr];
    const minCT = allCompTemps.length ? Math.min(...allCompTemps) : 25;
    const maxCT = allCompTemps.length ? Math.max(...allCompTemps) : 30;
    const spanCT = maxCT - minCT;
    const padCT = spanCT < 5.0 ? (5.0 - spanCT) / 2 : 1.0;
    const yCompTempMin = Math.floor(minCT - padCT);
    const yCompTempMax = Math.ceil(maxCT + padCT);

    this.comparisonChart.data.labels = labels;
    this.comparisonChart.data.datasets[0].data = extTempArr;
    this.comparisonChart.data.datasets[0].borderColor = extTempColor;

    this.comparisonChart.data.datasets[1].data = extRhArr;
    this.comparisonChart.data.datasets[1].borderColor = extRhColor;

    this.comparisonChart.data.datasets[2].data = localTempArr;
    this.comparisonChart.data.datasets[2].borderColor = sensorTempColor;
    this.comparisonChart.data.datasets[2].pointBackgroundColor = sensorTempColor;
    this.comparisonChart.data.datasets[2].pointBorderColor = isDarkMode ? "#171a1f" : "#ffffff";

    this.comparisonChart.data.datasets[3].data = localRhArr;
    this.comparisonChart.data.datasets[3].borderColor = sensorRhColor;
    this.comparisonChart.data.datasets[3].pointBackgroundColor = sensorRhColor;
    this.comparisonChart.data.datasets[3].pointBorderColor = isDarkMode ? "#171a1f" : "#ffffff";

    this.comparisonChart.options.scales.yTemp.suggestedMin = yCompTempMin;
    this.comparisonChart.options.scales.yTemp.suggestedMax = yCompTempMax;
    this.comparisonChart.update("none");
  }

  renderComparisonChart() {
    this.updateDeltaCards();
    this.initComparisonChart();
    this.updateComparisonChart();
  }
}
