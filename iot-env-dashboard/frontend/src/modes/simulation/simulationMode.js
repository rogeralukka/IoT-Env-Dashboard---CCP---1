/**
 * Mode 2: Simulation Mode Module (Phase 3 Interactive Workbench).
 * Redesigned to match the MS Paint bench architecture:
 *
 * LAYOUT (Top to Bottom):
 * Row 1: [OLED SCREEN IN 2:1 BEZEL, left ~5fr] | [CIRCUIT DIAGRAM + CONTROLS, right ~7fr]
 * Row 2: Rolling 30-Point Telemetry Graphs Panel (flex: 1, min-height 220px)
 *
 * KEY CAPABILITIES:
 * 1. ONE SOURCE OF TRUTH: Single shared state object & renderOledSvg(state) for both OLED screens.
 * 2. ZOOM EFFECT: Left card shows zoomed 2:1 screen; wedge links to frame around small screen.
 * 3. CONTROLS IN HEADER: Power and Rate controls right-aligned in Circuit card header.
 * 4. ONE-SCREEN DESKTOP: Entire view fits inside 100dvh without vertical scrolling on desktop.
 * 5. DEVICE STATE OUTSIDE: Driven by global deviceStore singleton, ticks in background across tabs.
 */

import { deviceStore, renderOledSvg } from "../../services/deviceStore.js?v=3.12.0";

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

export class SimulationMode {
  constructor(container) {
    this.container = container;

    // Chart.js instance
    this.simChart = null;

    // Store subscription unbind callback
    this.unsubscribeStore = null;

    // Resize observer and listeners
    this.resizeHandler = null;
    this.resizeObserver = null;
  }

  /**
   * Initializes Simulation Mode view.
   */
  init() {
    this.render();
    this.bindEvents();
    this.initSimChart();

    // Subscribe to global deviceStore singleton
    // Immediately invokes callback with current state and history
    this.unsubscribeStore = deviceStore.subscribe((state, history) => {
      this.onStoreUpdate(state, history);
    });

    // Setup dynamic zoom connector wedge
    this.setupZoomConnector();
  }

  /**
   * Lifecycle teardown: clean up listeners, observers and chart.
   * DeviceStore singleton continues running safely in the background.
   */
  destroy() {
    if (this.unsubscribeStore) {
      this.unsubscribeStore();
      this.unsubscribeStore = null;
    }

    if (this.simChart) {
      this.simChart.destroy();
      this.simChart = null;
    }

    if (this.resizeHandler) {
      window.removeEventListener("resize", this.resizeHandler);
      this.resizeHandler = null;
    }

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
  }

  /**
   * Handles theme switch (Light <-> Dark mode).
   */
  onThemeChange() {
    if (this.simChart) {
      this.simChart.destroy();
      this.initSimChart();
      this.updateSimChart(deviceStore.getHistory());
    }
    this.updateZoomWedge();
  }

  /**
   * Store subscriber update handler:
   * Synchronously renders both OLED screens from the single shared state,
   * updates hardware controls and wire animations, and refreshes the chart.
   */
  onStoreUpdate(state, history) {
    // 1. Single function render for both OLED screens in the same tick
    const largeSvg = this.container.querySelector("#largeOledScreenSvg");
    const smallSvg = this.container.querySelector("#smallOledScreenSvg");
    const oledMarkup = renderOledSvg(state);

    if (largeSvg) largeSvg.innerHTML = oledMarkup;
    if (smallSvg) smallSvg.innerHTML = oledMarkup;

    // 2. Update Header Controls in Circuit Card
    const btnPower = this.container.querySelector("#btnPowerToggle");
    const powerLabel = this.container.querySelector("#powerLabel");
    if (btnPower && powerLabel) {
      btnPower.className = `btn-power-toggle ${state.isPoweredOn ? "power-on" : "power-off"}`;
      powerLabel.textContent = state.isPoweredOn ? "POWER: ON" : "POWER: OFF";
    }

    const speedButtons = this.container.querySelectorAll(".speed-btn");
    speedButtons.forEach((btn) => {
      const spd = parseInt(btn.getAttribute("data-speed"), 10);
      btn.classList.toggle("active", spd === state.publishIntervalMs);
    });

    // 3. Update Hardware Circuit LEDs & Wires
    const pwrLed = this.container.querySelector("#svgPwrLed");
    const txLed = this.container.querySelector("#svgTxLed");
    const wires = this.container.querySelectorAll(".circuit-wire");

    if (!state.isPoweredOn) {
      // Powered OFF: blank screens, static wires, LEDs dark
      if (pwrLed) pwrLed.setAttribute("fill", "#3f1115");
      if (txLed) txLed.setAttribute("fill", "#0c2b3d");
      wires.forEach((w) => {
        w.classList.add("wire-offline");
        w.classList.remove("wire-data-pulse");
      });
    } else if (state.isBooting) {
      // Booting: Amber power LED, inactive wires
      if (pwrLed) pwrLed.setAttribute("fill", "#f59e0b");
      if (txLed) txLed.setAttribute("fill", "#0c2b3d");
      wires.forEach((w) => {
        w.classList.remove("wire-offline");
        w.classList.remove("wire-data-pulse");
      });
    } else {
      // Operational: Red power LED, active data pulses
      if (pwrLed) pwrLed.setAttribute("fill", "#ef4444");
      wires.forEach((w) => w.classList.remove("wire-offline"));
      this.triggerDataFlowAnimation();
    }

    // 4. Update DHT11 Live Readout inside Circuit Schematic
    const dht11Readout = this.container.querySelector("#dht11LiveReadout");
    if (dht11Readout) {
      if (state.isPoweredOn && !state.isBooting) {
        dht11Readout.textContent = `${Number(state.temperature).toFixed(1)}C  ${Math.round(state.humidity)}%`;
      } else {
        dht11Readout.textContent = "--";
      }
    }

    // 5. Update rolling 30-point chart (in-place, no animation flicker)
    this.updateSimChart(history);

    // 6. Realign zoom connector wedge
    this.updateZoomWedge();
  }

  /**
   * Pulses jumper wires and status LEDs to visually represent I2C & GPIO bus traffic.
   */
  triggerDataFlowAnimation() {
    const wireData = this.container.querySelector("#wireData1");
    const wireSda = this.container.querySelector("#wireSda");
    const wireScl = this.container.querySelector("#wireScl");
    const txLed = this.container.querySelector("#svgTxLed");

    if (wireData) {
      wireData.classList.remove("wire-data-pulse");
      void wireData.offsetWidth;
      wireData.classList.add("wire-data-pulse");
    }

    setTimeout(() => {
      if (wireSda) {
        wireSda.classList.remove("wire-data-pulse");
        void wireSda.offsetWidth;
        wireSda.classList.add("wire-data-pulse");
      }
      if (wireScl) {
        wireScl.classList.remove("wire-data-pulse");
        void wireScl.offsetWidth;
        wireScl.classList.add("wire-data-pulse");
      }
      if (txLed) {
        txLed.setAttribute("fill", "#38bdf8");
        setTimeout(() => {
          if (txLed) txLed.setAttribute("fill", "#0284c7");
        }, 150);
      }
    }, 120);
  }

  /**
   * Sets up dynamic zoom connector wedge linking the big OLED bezel to the small OLED frame.
   */
  setupZoomConnector() {
    this.updateZoomWedge();

    this.resizeHandler = () => this.updateZoomWedge();
    window.addEventListener("resize", this.resizeHandler, { passive: true });

    const workbench = this.container.querySelector("#simWorkbenchRow");
    if (workbench && typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.updateZoomWedge());
      this.resizeObserver.observe(workbench);
    }
  }

  /**
   * Recalculates coordinates for the translucent polygon wedge connector.
   * Desktop only: connects right edge of large bezel to dashed frame of small OLED.
   */
  updateZoomWedge() {
    const workbench = this.container.querySelector("#simWorkbenchRow");
    const bezel = this.container.querySelector("#largeOledBezel");
    const frame = this.container.querySelector("#oledHighlightFrame");
    const wedge = this.container.querySelector("#zoomWedge");

    if (!workbench || !bezel || !frame || !wedge) return;

    if (window.innerWidth < 1024) {
      wedge.setAttribute("display", "none");
      return;
    }
    wedge.removeAttribute("display");

    const wRect = workbench.getBoundingClientRect();
    const bRect = bezel.getBoundingClientRect();
    const fRect = frame.getBoundingClientRect();

    const xLeft = Math.round(bRect.right - wRect.left);
    const yLeftTop = Math.round(bRect.top - wRect.top);
    const yLeftBottom = Math.round(bRect.bottom - wRect.top);

    const xFrame = Math.round(fRect.left - wRect.left);
    const yFrameTop = Math.round(fRect.top - wRect.top);
    const yFrameBottom = Math.round(fRect.bottom - wRect.top);

    wedge.setAttribute(
      "points",
      `${xLeft},${yLeftTop} ${xFrame},${yFrameTop} ${xFrame},${yFrameBottom} ${xLeft},${yLeftBottom}`
    );
  }

  /**
   * Initializes the rolling 30-point Chart.js graph once.
   * Animation is strictly disabled to prevent re-animation glitching on every tick.
   */
  initSimChart() {
    const canvas = this.container.querySelector("#simTelemetryChart");
    if (!canvas || typeof Chart === "undefined") return;

    const ctx = canvas.getContext("2d");
    const isDarkMode = document.documentElement.getAttribute("data-theme") === "dark";
    const gridColor = isDarkMode ? "rgba(233, 235, 238, 0.06)" : "rgba(27, 25, 22, 0.08)";
    const textColor = isDarkMode ? "#9aa1ab" : "#5e5950";
    const tempColor = isDarkMode ? "#fb923c" : "#ea580c";
    const hiColor = isDarkMode ? "#b794f6" : "#7c3aed";
    const rhColor = isDarkMode ? "#4ade80" : "#167a3f";

    this.simChart = new Chart(ctx, {
      type: "line",
      data: {
        labels: [],
        datasets: [
          {
            label: "Temperature (°C)",
            data: [],
            borderColor: tempColor,
            backgroundColor: (c) => getVerticalGradient(c, tempColor, isDarkMode ? 0.18 : 0.22),
            borderWidth: 2,
            pointRadius: 2.5,
            pointBackgroundColor: tempColor,
            pointBorderColor: isDarkMode ? "#0e1013" : "#ffffff",
            yAxisID: "yTemp",
            tension: 0.25,
            fill: true,
          },
          {
            label: "Heat Index (°C)",
            data: [],
            borderColor: hiColor,
            borderDash: [5, 4],
            borderWidth: 2,
            pointRadius: 0,
            yAxisID: "yTemp",
            tension: 0.25,
            fill: false,
          },
          {
            label: "Relative Humidity (%)",
            data: [],
            borderColor: rhColor,
            borderWidth: 2,
            pointRadius: 2.5,
            pointBackgroundColor: rhColor,
            pointBorderColor: isDarkMode ? "#0e1013" : "#ffffff",
            yAxisID: "yHum",
            tension: 0.25,
            fill: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false, // Requirement 4: Disable live animation glitches
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
              text: "Temp & Heat Index (°C)",
              color: tempColor,
              font: { family: "'Space Grotesk', sans-serif", weight: 600, size: 11 },
            },
            grid: { color: gridColor },
            ticks: {
              color: textColor,
              font: { family: "'IBM Plex Mono', monospace", size: 10 },
            },
          },
          yHum: {
            type: "linear",
            position: "right",
            min: 0,
            max: 100,
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
          },
        },
      },
    });
  }

  /**
   * Updates rolling chart with accumulated history from deviceStore in-place.
   * Calls chart.update('none') to prevent replay of entry animations.
   */
  updateSimChart(history = []) {
    const emptyState = this.container.querySelector("#simChartEmptyState");
    if (emptyState) {
      emptyState.classList.toggle("hidden", history.length > 0);
    }

    if (!this.simChart) return;

    const labels = history.map((p) => p.time);
    const dataTemp = history.map((p) => p.temperature_c);
    const dataHi = history.map((p) => p.heat_index_c);
    const dataRh = history.map((p) => p.humidity_pct);

    const allTemps = [...dataTemp, ...dataHi];
    const minT = allTemps.length ? Math.min(...allTemps) : 25;
    const maxT = allTemps.length ? Math.max(...allTemps) : 30;
    const spanT = maxT - minT;
    const padT = spanT < 5.0 ? (5.0 - spanT) / 2 : 1.0;

    const isDarkMode = document.documentElement.getAttribute("data-theme") === "dark";
    const gridColor = isDarkMode ? "rgba(233, 235, 238, 0.06)" : "rgba(27, 25, 22, 0.08)";
    const textColor = isDarkMode ? "#9aa1ab" : "#5e5950";
    const tempColor = isDarkMode ? "#fb923c" : "#ea580c";
    const hiColor = isDarkMode ? "#b794f6" : "#7c3aed";
    const rhColor = isDarkMode ? "#4ade80" : "#167a3f";

    this.simChart.data.labels = labels;
    this.simChart.data.datasets[0].data = dataTemp;
    this.simChart.data.datasets[0].borderColor = tempColor;
    this.simChart.data.datasets[0].backgroundColor = (c) =>
      getVerticalGradient(c, tempColor, isDarkMode ? 0.18 : 0.22);
    this.simChart.data.datasets[0].pointBackgroundColor = tempColor;
    this.simChart.data.datasets[0].pointBorderColor = isDarkMode ? "#0e1013" : "#ffffff";

    this.simChart.data.datasets[1].data = dataHi;
    this.simChart.data.datasets[1].borderColor = hiColor;

    this.simChart.data.datasets[2].data = dataRh;
    this.simChart.data.datasets[2].borderColor = rhColor;
    this.simChart.data.datasets[2].pointBackgroundColor = rhColor;
    this.simChart.data.datasets[2].pointBorderColor = isDarkMode ? "#0e1013" : "#ffffff";

    if (this.simChart.options.scales && this.simChart.options.scales.yTemp) {
      this.simChart.options.scales.yTemp.suggestedMin = Math.floor(minT - padT);
      this.simChart.options.scales.yTemp.suggestedMax = Math.ceil(maxT + padT);
      this.simChart.options.scales.yTemp.grid.color = gridColor;
      this.simChart.options.scales.yTemp.ticks.color = textColor;
    }
    if (this.simChart.options.scales && this.simChart.options.scales.x) {
      this.simChart.options.scales.x.grid.color = gridColor;
      this.simChart.options.scales.x.ticks.color = textColor;
    }
    if (this.simChart.options.scales && this.simChart.options.scales.yHum) {
      this.simChart.options.scales.yHum.ticks.color = textColor;
    }

    this.simChart.update("none");
  }

  /**
   * Renders the complete Simulation Workbench DOM structure.
   */
  render() {
    this.container.innerHTML = `
      <div class="sim-container">
        <!-- ROW 1: [OLED SCREEN IN 2:1 BEZEL, left ~5fr] | [CIRCUIT DIAGRAM + CONTROLS, right ~7fr] -->
        <div id="simWorkbenchRow" class="sim-row-workbench">
          <!-- Column 1: OLED Screen Only in Bezel Frame (LEFT ~5fr) -->
          <article class="oled-emulator-card" id="zoomedOledCard">
            <div class="panel-header" style="margin-bottom: 0.4rem;">
              <h3>OLED</h3>
            </div>

            <div class="oled-large-wrapper">
              <div class="oled-bezel-frame" id="largeOledBezel">
                <svg id="largeOledScreenSvg" viewBox="0 0 256 128" width="100%" height="100%" preserveAspectRatio="xMidYMid meet"></svg>
              </div>
            </div>
          </article>

          <!-- Column 2: Hardware Circuit Visualizer & Controls (RIGHT ~7fr) -->
          <article class="hardware-card" id="circuitDiagramCard">
            <div class="panel-header circuit-header-with-controls">
              <h3>Circuit</h3>
              <div class="circuit-header-controls">
                <button id="btnPowerToggle" class="btn-power-toggle power-off" title="Toggle node power">
                  <span id="powerIcon">⏻</span>
                  <span id="powerLabel">POWER: OFF</span>
                </button>
                <div class="rate-selector-wrap">
                  <span class="rate-label">Rate:</span>
                  <div class="speed-selector-group">
                    <button id="btnSpeed1s" class="speed-btn" data-speed="1000" title="1s (1Hz)">1s</button>
                    <button id="btnSpeed2s" class="speed-btn active" data-speed="2000" title="2s (0.5Hz)">2s</button>
                    <button id="btnSpeed5s" class="speed-btn" data-speed="5000" title="5s (0.2Hz)">5s</button>
                  </div>
                </div>
              </div>
            </div>

            <!-- SVG Circuit Schematic (Restored viewBox 0 14 1024 460) -->
            <div class="circuit-svg-container" aria-label="Circuit wiring diagram of ESP32, DHT11, and SSD1306 OLED">
              <svg id="schematicSvg" width="100%" height="100%" viewBox="0 14 1024 460" preserveAspectRatio="xMidYMid meet">
                <defs>
                  <filter id="neonGlow" x="-20%" y="-20%" width="140%" height="140%">
                    <feGaussianBlur stdDeviation="2.5" result="blur" />
                    <feMerge>
                      <feMergeNode in="blur" />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                  <pattern id="workbenchGrid" width="20" height="20" patternUnits="userSpaceOnUse">
                    <circle cx="2" cy="2" r="1" fill="currentColor" opacity="0.14" />
                  </pattern>
                  <linearGradient id="shieldGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stop-color="#cbd5e1" />
                    <stop offset="50%" stop-color="#94a3b8" />
                    <stop offset="100%" stop-color="#64748b" />
                  </linearGradient>
                </defs>

                <!-- Grid Background -->
                <rect width="100%" height="100%" fill="url(#workbenchGrid)" />

                <!-- ================= 1. OLED DISPLAY (SSD1306) 0.96" I2C (LEFT) ================= -->
                <g id="ssd1306Module" transform="translate(0, 0)">
                  <!-- Deep Blue PCB -->
                  <rect x="40" y="90" width="235" height="260" rx="8" fill="#0f4d7c" stroke="#1d6fa5" stroke-width="1.5"/>

                  <!-- 4 Mounting Holes -->
                  <circle cx="56" cy="106" r="5.5" fill="#0a3250" stroke="#ecc98a" stroke-width="1.5"/>
                  <circle cx="259" cy="106" r="5.5" fill="#0a3250" stroke="#ecc98a" stroke-width="1.5"/>
                  <circle cx="56" cy="334" r="5.5" fill="#0a3250" stroke="#ecc98a" stroke-width="1.5"/>
                  <circle cx="259" cy="334" r="5.5" fill="#0a3250" stroke="#ecc98a" stroke-width="1.5"/>

                  <!-- Header Socket Strip at Top -->
                  <rect x="90" y="92" width="135" height="16" rx="2" fill="#1e293b"/>

                  <!-- Pin 1: GND (cx = 108, cy = 100) -->
                  <circle cx="108" cy="100" r="5" fill="#18181b" stroke="#9ca3af" stroke-width="2"/>
                  <circle cx="108" cy="100" r="2.5" fill="#09090b"/>
                  <text x="108" y="122" font-family="monospace" font-size="7.5" font-weight="700" fill="#ffffff" text-anchor="middle">GND</text>

                  <!-- Pin 2: VCC (cx = 138, cy = 100) -->
                  <circle cx="138" cy="100" r="5" fill="#18181b" stroke="#ef4444" stroke-width="2"/>
                  <circle cx="138" cy="100" r="2.5" fill="#09090b"/>
                  <text x="138" y="122" font-family="monospace" font-size="7.5" font-weight="700" fill="#ffffff" text-anchor="middle">VCC</text>

                  <!-- Pin 3: SCL (cx = 168, cy = 100) -->
                  <circle cx="168" cy="100" r="5" fill="#18181b" stroke="#eab308" stroke-width="2"/>
                  <circle cx="168" cy="100" r="2.5" fill="#09090b"/>
                  <text x="168" y="122" font-family="monospace" font-size="7.5" font-weight="700" fill="#ffffff" text-anchor="middle">SCL</text>

                  <!-- Pin 4: SDA (cx = 198, cy = 100) -->
                  <circle cx="198" cy="100" r="5" fill="#18181b" stroke="#3b82f6" stroke-width="2"/>
                  <circle cx="198" cy="100" r="2.5" fill="#09090b"/>
                  <text x="198" y="122" font-family="monospace" font-size="7.5" font-weight="700" fill="#ffffff" text-anchor="middle">SDA</text>

                  <!-- 0.96" OLED Glass Screen (2:1 aspect ratio matching zoomed OLED screen) -->
                  <rect id="svgOledGlass" x="49.5" y="160" width="216" height="108" rx="4" fill="#02060a" stroke="rgba(255, 255, 255, 0.14)" stroke-width="1"/>

                  <!-- Yellow Flex Ribbon Cable (Bottom) -->
                  <rect x="115" y="268" width="85" height="14" rx="1" fill="#d97706" opacity="0.9"/>
                  <line x1="125" y1="268" x2="125" y2="282" stroke="#b45309" stroke-width="1"/>
                  <line x1="145" y1="268" x2="145" y2="282" stroke="#b45309" stroke-width="1"/>
                  <line x1="165" y1="268" x2="165" y2="282" stroke="#b45309" stroke-width="1"/>
                  <line x1="185" y1="268" x2="185" y2="282" stroke="#b45309" stroke-width="1"/>

                  <!-- Inner 256x128 Vector Phosphor Display (2:1 aspect ratio) -->
                  <svg id="smallOledScreenSvg" x="51.5" y="161" width="212" height="106" viewBox="0 0 256 128" preserveAspectRatio="xMidYMid meet"></svg>
                </g>

                <!-- 2px dashed terracotta rounded frame around small OLED screen (2:1 aspect ratio matching large bezel) -->
                <rect id="oledHighlightFrame" x="43.5" y="157" width="228" height="114" rx="6" fill="none" stroke="var(--accent-terracotta)" stroke-width="2" stroke-dasharray="6 4"/>

                <!-- Label Box: OLED Display (SSD1306) -->
                <g class="schematic-label-pill" transform="translate(47.5, 370)">
                  <rect width="220" height="48" rx="10"/>
                  <text class="pill-title" x="110" y="21" text-anchor="middle">OLED Display (SSD1306)</text>
                  <text class="pill-sub" x="110" y="38" text-anchor="middle">0.96" I2C</text>
                </g>

                <!-- ================= 2. ESP32-WROOM-32 MICROCONTROLLER (CENTER) ================= -->
                <g id="esp32Board" transform="translate(0, 0)">
                  <!-- Main PCB -->
                  <rect x="410" y="85" width="210" height="325" rx="8" fill="#18191c" stroke="#2e323b" stroke-width="2"/>

                  <!-- Gold PCB Trace Antenna (Top) -->
                  <rect x="440" y="88" width="150" height="28" rx="2" fill="#121316"/>
                  <path d="M 455 92 L 455 110 L 467 110 L 467 95 L 479 95 L 479 110 L 491 110 L 491 95 L 503 95 L 503 110 L 515 110 L 515 95 L 527 95 L 527 110 L 539 110 L 539 95 L 551 95 L 551 110 L 563 110 L 563 92" 
                        fill="none" stroke="#d97706" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  <text x="515" y="120" font-family="monospace" font-size="6.5" fill="#b45309" text-anchor="middle" font-weight="700">2.4 GHz PCB ANTENNA</text>

                  <!-- ESP-WROOM-32 Metal RF Shield -->
                  <rect x="455" y="126" width="120" height="102" rx="4" fill="url(#shieldGrad)" stroke="#475569" stroke-width="1.5"/>
                  <rect x="459" y="130" width="112" height="94" rx="2" fill="#cbd5e1" opacity="0.15" />
                  <text x="515" y="152" font-family="'Space Grotesk', sans-serif" font-size="10.5" font-weight="700" fill="#0f172a" text-anchor="middle">ESP-WROOM-32</text>
                  <text x="515" y="167" font-family="monospace" font-size="7.5" fill="#1e293b" text-anchor="middle">Wi-Fi + BT SoC</text>
                  <text x="515" y="180" font-family="monospace" font-size="6.5" fill="#334155" text-anchor="middle">FCC ID: 2AC7Z</text>
                  <text x="515" y="191" font-family="monospace" font-size="6.5" fill="#475569" text-anchor="middle">CE 0700 Espressif</text>

                  <!-- USB-to-UART CP2102 IC -->
                  <rect x="502" y="246" width="26" height="26" rx="2" fill="#1e2024" stroke="#475569" stroke-width="1"/>
                  <circle cx="508" cy="252" r="1.5" fill="#94a3b8"/>
                  <text x="515" y="262" font-family="monospace" font-size="6" fill="#64748b" text-anchor="middle">CP2102</text>

                  <!-- Status LEDs -->
                  <circle id="svgPwrLed" cx="482" cy="236" r="4" fill="#ef4444" filter="url(#neonGlow)"/>
                  <text x="482" y="248" font-family="monospace" font-size="6.5" fill="#9ca3af" text-anchor="middle">PWR</text>

                  <circle id="svgTxLed" cx="548" cy="236" r="4" fill="#0284c7" />
                  <text x="548" y="248" font-family="monospace" font-size="6.5" fill="#9ca3af" text-anchor="middle">IO2</text>

                  <!-- EN and BOOT Buttons -->
                  <rect x="470" y="328" width="18" height="18" rx="2.5" fill="#334155" stroke="#0f172a" stroke-width="1"/>
                  <circle cx="479" cy="337" r="4.5" fill="#cbd5e1"/>
                  <text x="479" y="356" font-family="monospace" font-size="6.5" font-weight="700" fill="#94a3b8" text-anchor="middle">EN</text>

                  <rect x="542" y="328" width="18" height="18" rx="2.5" fill="#334155" stroke="#0f172a" stroke-width="1"/>
                  <circle cx="551" cy="337" r="4.5" fill="#cbd5e1"/>
                  <text x="551" y="356" font-family="monospace" font-size="6.5" font-weight="700" fill="#94a3b8" text-anchor="middle">BOOT</text>

                  <!-- Micro-USB Connector (Bottom) -->
                  <rect x="495" y="396" width="40" height="16" rx="2" fill="#94a3b8" stroke="#475569" stroke-width="1"/>
                  <rect x="502" y="402" width="26" height="8" rx="1" fill="#0f172a" />
                  <text x="515" y="390" font-family="monospace" font-size="6" fill="#64748b" text-anchor="middle">MICRO-USB</text>

                  <!-- Left Pin Header (15 Pins) -->
                  <circle cx="422" cy="100" r="4.5" fill="#18181b" stroke="#f59e0b" stroke-width="2"/><circle cx="422" cy="100" r="2" fill="#09090b"/>
                  <text x="434" y="103" font-family="monospace" font-size="7.5" font-weight="700" fill="#f59e0b">3V3</text>
                  <circle cx="422" cy="120" r="4.5" fill="#18181b" stroke="#94a3b8" stroke-width="1.5"/><circle cx="422" cy="120" r="2" fill="#09090b"/>
                  <text x="434" y="123" font-family="monospace" font-size="7.5" fill="#cbd5e1">EN</text>
                  <circle cx="422" cy="140" r="4.5" fill="#18181b" stroke="#94a3b8" stroke-width="1.5"/><circle cx="422" cy="140" r="2" fill="#09090b"/>
                  <text x="434" y="143" font-family="monospace" font-size="7.5" fill="#cbd5e1">VP</text>
                  <circle cx="422" cy="160" r="4.5" fill="#18181b" stroke="#94a3b8" stroke-width="1.5"/><circle cx="422" cy="160" r="2" fill="#09090b"/>
                  <text x="434" y="163" font-family="monospace" font-size="7.5" fill="#cbd5e1">VN</text>
                  <circle cx="422" cy="180" r="4.5" fill="#18181b" stroke="#94a3b8" stroke-width="1.5"/><circle cx="422" cy="180" r="2" fill="#09090b"/>
                  <text x="434" y="183" font-family="monospace" font-size="7.5" fill="#cbd5e1">34</text>
                  <circle cx="422" cy="200" r="4.5" fill="#18181b" stroke="#94a3b8" stroke-width="1.5"/><circle cx="422" cy="200" r="2" fill="#09090b"/>
                  <text x="434" y="203" font-family="monospace" font-size="7.5" fill="#cbd5e1">35</text>
                  <circle cx="422" cy="220" r="4.5" fill="#18181b" stroke="#94a3b8" stroke-width="1.5"/><circle cx="422" cy="220" r="2" fill="#09090b"/>
                  <text x="434" y="223" font-family="monospace" font-size="7.5" fill="#cbd5e1">32</text>
                  <circle cx="422" cy="240" r="4.5" fill="#18181b" stroke="#94a3b8" stroke-width="1.5"/><circle cx="422" cy="240" r="2" fill="#09090b"/>
                  <text x="434" y="243" font-family="monospace" font-size="7.5" fill="#cbd5e1">33</text>
                  <circle cx="422" cy="260" r="4.5" fill="#18181b" stroke="#94a3b8" stroke-width="1.5"/><circle cx="422" cy="260" r="2" fill="#09090b"/>
                  <text x="434" y="263" font-family="monospace" font-size="7.5" fill="#cbd5e1">25</text>
                  <circle cx="422" cy="280" r="4.5" fill="#18181b" stroke="#94a3b8" stroke-width="1.5"/><circle cx="422" cy="280" r="2" fill="#09090b"/>
                  <text x="434" y="283" font-family="monospace" font-size="7.5" fill="#cbd5e1">26</text>
                  <circle cx="422" cy="300" r="4.5" fill="#18181b" stroke="#94a3b8" stroke-width="1.5"/><circle cx="422" cy="300" r="2" fill="#09090b"/>
                  <text x="434" y="303" font-family="monospace" font-size="7.5" fill="#cbd5e1">27</text>
                  <circle cx="422" cy="320" r="4.5" fill="#18181b" stroke="#94a3b8" stroke-width="1.5"/><circle cx="422" cy="320" r="2" fill="#09090b"/>
                  <text x="434" y="323" font-family="monospace" font-size="7.5" fill="#cbd5e1">14</text>
                  <circle cx="422" cy="340" r="4.5" fill="#18181b" stroke="#94a3b8" stroke-width="1.5"/><circle cx="422" cy="340" r="2" fill="#09090b"/>
                  <text x="434" y="343" font-family="monospace" font-size="7.5" fill="#cbd5e1">12</text>
                  <circle cx="422" cy="360" r="4.5" fill="#18181b" stroke="#cbd5e1" stroke-width="2"/><circle cx="422" cy="360" r="2" fill="#09090b"/>
                  <text x="434" y="363" font-family="monospace" font-size="7.5" font-weight="700" fill="#cbd5e1">GND</text>
                  <circle cx="422" cy="380" r="4.5" fill="#18181b" stroke="#94a3b8" stroke-width="1.5"/><circle cx="422" cy="380" r="2" fill="#09090b"/>
                  <text x="434" y="383" font-family="monospace" font-size="7.5" fill="#cbd5e1">13</text>

                  <!-- Right Pin Header (15 Pins) -->
                  <circle cx="608" cy="100" r="4.5" fill="#18181b" stroke="#cbd5e1" stroke-width="2"/><circle cx="608" cy="100" r="2" fill="#09090b"/>
                  <text x="596" y="103" font-family="monospace" font-size="7.5" font-weight="700" fill="#cbd5e1" text-anchor="end">GND</text>
                  <circle cx="608" cy="120" r="4.5" fill="#18181b" stroke="#94a3b8" stroke-width="1.5"/><circle cx="608" cy="120" r="2" fill="#09090b"/>
                  <text x="596" y="123" font-family="monospace" font-size="7.5" fill="#cbd5e1" text-anchor="end">23</text>
                  <circle cx="608" cy="140" r="4.5" fill="#18181b" stroke="#eab308" stroke-width="2"/><circle cx="608" cy="140" r="2" fill="#09090b"/>
                  <text x="596" y="143" font-family="monospace" font-size="7.5" font-weight="700" fill="#eab308" text-anchor="end">22</text>
                  <circle cx="608" cy="160" r="4.5" fill="#18181b" stroke="#94a3b8" stroke-width="1.5"/><circle cx="608" cy="160" r="2" fill="#09090b"/>
                  <text x="596" y="163" font-family="monospace" font-size="7.5" fill="#cbd5e1" text-anchor="end">TX0</text>
                  <circle cx="608" cy="180" r="4.5" fill="#18181b" stroke="#3b82f6" stroke-width="2"/><circle cx="608" cy="180" r="2" fill="#09090b"/>
                  <text x="596" y="183" font-family="monospace" font-size="7.5" font-weight="700" fill="#3b82f6" text-anchor="end">21</text>
                  <circle cx="608" cy="200" r="4.5" fill="#18181b" stroke="#94a3b8" stroke-width="1.5"/><circle cx="608" cy="200" r="2" fill="#09090b"/>
                  <text x="596" y="203" font-family="monospace" font-size="7.5" fill="#cbd5e1" text-anchor="end">19</text>
                  <circle cx="608" cy="220" r="4.5" fill="#18181b" stroke="#94a3b8" stroke-width="1.5"/><circle cx="608" cy="220" r="2" fill="#09090b"/>
                  <text x="596" y="223" font-family="monospace" font-size="7.5" fill="#cbd5e1" text-anchor="end">18</text>
                  <circle cx="608" cy="240" r="4.5" fill="#18181b" stroke="#94a3b8" stroke-width="1.5"/><circle cx="608" cy="240" r="2" fill="#09090b"/>
                  <text x="596" y="243" font-family="monospace" font-size="7.5" fill="#cbd5e1" text-anchor="end">5</text>
                  <circle cx="608" cy="260" r="4.5" fill="#18181b" stroke="#94a3b8" stroke-width="1.5"/><circle cx="608" cy="260" r="2" fill="#09090b"/>
                  <text x="596" y="263" font-family="monospace" font-size="7.5" fill="#cbd5e1" text-anchor="end">17</text>
                  <circle cx="608" cy="280" r="4.5" fill="#18181b" stroke="#94a3b8" stroke-width="1.5"/><circle cx="608" cy="280" r="2" fill="#09090b"/>
                  <text x="596" y="283" font-family="monospace" font-size="7.5" fill="#cbd5e1" text-anchor="end">16</text>
                  <circle cx="608" cy="300" r="4.5" fill="#18181b" stroke="#22c55e" stroke-width="2"/><circle cx="608" cy="300" r="2" fill="#09090b"/>
                  <text x="596" y="303" font-family="monospace" font-size="7.5" font-weight="700" fill="#22c55e" text-anchor="end">4</text>
                  <circle cx="608" cy="320" r="4.5" fill="#18181b" stroke="#94a3b8" stroke-width="1.5"/><circle cx="608" cy="320" r="2" fill="#09090b"/>
                  <text x="596" y="323" font-family="monospace" font-size="7.5" fill="#cbd5e1" text-anchor="end">0</text>
                  <circle cx="608" cy="340" r="4.5" fill="#18181b" stroke="#94a3b8" stroke-width="1.5"/><circle cx="608" cy="340" r="2" fill="#09090b"/>
                  <text x="596" y="343" font-family="monospace" font-size="7.5" fill="#cbd5e1" text-anchor="end">2</text>
                  <circle cx="608" cy="360" r="4.5" fill="#18181b" stroke="#94a3b8" stroke-width="1.5"/><circle cx="608" cy="360" r="2" fill="#09090b"/>
                  <text x="596" y="363" font-family="monospace" font-size="7.5" fill="#cbd5e1" text-anchor="end">15</text>
                  <circle cx="608" cy="380" r="4.5" fill="#18181b" stroke="#94a3b8" stroke-width="1.5"/><circle cx="608" cy="380" r="2" fill="#09090b"/>
                  <text x="596" y="383" font-family="monospace" font-size="7.5" fill="#cbd5e1" text-anchor="end">D1</text>
                </g>

                <!-- Label Box: ESP32-WROOM-32 -->
                <g class="schematic-label-pill" transform="translate(425, 422)">
                  <rect width="180" height="46" rx="10"/>
                  <text class="pill-title" x="90" y="20" text-anchor="middle">ESP32-WROOM-32</text>
                  <text class="pill-sub" x="90" y="36" text-anchor="middle">(Microcontroller)</text>
                </g>

                <!-- ================= 3. DHT11 SENSOR MODULE (RIGHT) ================= -->
                <g id="dht11Module" transform="translate(0, 0)">
                  <!-- Module PCB -->
                  <rect x="770" y="145" width="180" height="185" rx="6" fill="#0a2540" stroke="#1e3a5f" stroke-width="1.5"/>

                  <!-- Slotted Blue Plastic Sensor Casing -->
                  <rect x="795" y="155" width="130" height="120" rx="6" fill="#0284c7" stroke="#0369a1" stroke-width="2"/>
                  <rect x="803" y="163" width="114" height="104" rx="3" fill="#0369a1"/>

                  <!-- Grille Air Vents -->
                  <g fill="#0284c7">
                    <rect x="812" y="172" width="26" height="4.5" rx="1"/><rect x="847" y="172" width="26" height="4.5" rx="1"/><rect x="882" y="172" width="26" height="4.5" rx="1"/>
                    <rect x="812" y="186" width="26" height="4.5" rx="1"/><rect x="847" y="186" width="26" height="4.5" rx="1"/><rect x="882" y="186" width="26" height="4.5" rx="1"/>
                    <rect x="812" y="200" width="26" height="4.5" rx="1"/><rect x="847" y="200" width="26" height="4.5" rx="1"/><rect x="882" y="200" width="26" height="4.5" rx="1"/>
                    <rect x="812" y="214" width="26" height="4.5" rx="1"/><rect x="847" y="214" width="26" height="4.5" rx="1"/><rect x="882" y="214" width="26" height="4.5" rx="1"/>
                    <rect x="812" y="228" width="26" height="4.5" rx="1"/><rect x="847" y="228" width="26" height="4.5" rx="1"/><rect x="882" y="228" width="26" height="4.5" rx="1"/>
                  </g>

                  <!-- Casing Markings -->
                  <text x="860" y="255" font-family="'Space Grotesk', sans-serif" font-size="10.5" font-weight="700" fill="#ffffff" text-anchor="middle">DHT11</text>
                  <text x="860" y="266" font-family="monospace" font-size="6" fill="#e0f2fe" text-anchor="middle">0-50C • 20-90%RH (1Hz)</text>

                  <!-- Red Indicator LED on Module PCB -->
                  <circle cx="930" cy="290" r="4.5" fill="#ef4444" stroke="#991b1b" stroke-width="1"/>

                  <!-- Silkscreen Pin Labels on PCB -->
                  <text x="815" y="312" font-family="monospace" font-size="8" font-weight="700" fill="#ffffff" text-anchor="middle">VCC</text>
                  <text x="860" y="312" font-family="monospace" font-size="8" font-weight="700" fill="#ffffff" text-anchor="middle">DATA</text>
                  <text x="905" y="312" font-family="monospace" font-size="8" font-weight="700" fill="#ffffff" text-anchor="middle">GND</text>

                  <!-- Male Header Strip at Bottom -->
                  <rect x="792" y="322" width="136" height="14" rx="2" fill="#1e293b"/>
                  <rect x="813" y="332" width="4" height="18" fill="#cbd5e1"/>
                  <rect x="858" y="332" width="4" height="18" fill="#cbd5e1"/>
                  <rect x="903" y="332" width="4" height="18" fill="#cbd5e1"/>

                  <!-- Pin Terminals (cy = 350) -->
                  <circle cx="815" cy="350" r="5" fill="#18181b" stroke="#ef4444" stroke-width="2"/><circle cx="815" cy="350" r="2.5" fill="#09090b"/>
                  <circle cx="860" cy="350" r="5" fill="#18181b" stroke="#22c55e" stroke-width="2"/><circle cx="860" cy="350" r="2.5" fill="#09090b"/>
                  <circle cx="905" cy="350" r="5" fill="#18181b" stroke="#9ca3af" stroke-width="2"/><circle cx="905" cy="350" r="2.5" fill="#09090b"/>
                </g>

                <!-- Label Box: DHT11 with live readout under title -->
                <g class="schematic-label-pill" transform="translate(760, 422)">
                  <rect width="200" height="46" rx="10"/>
                  <text class="pill-title" x="100" y="19" text-anchor="middle">DHT11</text>
                  <text id="dht11LiveReadout" class="pill-sub" x="100" y="36" text-anchor="middle" font-family="'IBM Plex Mono', monospace" font-weight="600">--</text>
                </g>

                <!-- ================= 4. ORTHOGONAL JUMPER WIRES ================= -->
                <!-- 1. RED WIRE: 3.3V Power Rail (ESP32 3V3 -> OLED VCC & DHT11 VCC) -->
                <path class="circuit-wire" d="M 422 100 L 380 100 L 380 44" fill="none" stroke="#ef4444" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                <path class="circuit-wire" d="M 380 44 L 138 44 L 138 100" fill="none" stroke="#ef4444" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                <path class="circuit-wire" d="M 380 44 L 725 44 L 725 350 L 815 350" fill="none" stroke="#ef4444" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                <circle cx="380" cy="44" r="4.5" fill="#ef4444" stroke="#991b1b" stroke-width="1.5"/>

                <!-- 2. BLACK WIRE: Ground Rail (ESP32 GND -> OLED GND & DHT11 GND) -->
                <path class="circuit-wire" d="M 608 100 L 608 22" fill="none" stroke="#64748b" stroke-width="3" stroke-linecap="round"/>
                <path class="circuit-wire" d="M 608 22 L 108 22 L 108 100" fill="none" stroke="#64748b" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                <path class="circuit-wire" d="M 608 22 L 960 22 L 960 350 L 905 350" fill="none" stroke="#64748b" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                <circle cx="608" cy="22" r="4.5" fill="#64748b" stroke="#1e293b" stroke-width="1.5"/>

                <!-- 3. GREEN WIRE: DHT11 DATA (ESP32 GPIO 4 -> DHT11 DATA) -->
                <path id="wireData1" class="circuit-wire" d="M 608 300 L 705 300 L 705 375 L 860 375 L 860 350" fill="none" stroke="#22c55e" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>

                <!-- 4. YELLOW WIRE: OLED SCL Clock (ESP32 GPIO 22 -> OLED SCL) -->
                <path id="wireScl" class="circuit-wire" d="M 608 140 L 635 140 L 635 64 L 168 64 L 168 100" fill="none" stroke="#eab308" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>

                <!-- 5. BLUE WIRE: OLED SDA Data (ESP32 GPIO 21 -> OLED SDA) -->
                <path id="wireSda" class="circuit-wire" d="M 608 180 L 650 180 L 650 80 L 198 80 L 198 100" fill="none" stroke="#3b82f6" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>

                <!-- Terminal Highlight Rings -->
                <circle cx="422" cy="100" r="7" fill="none" stroke="#ef4444" stroke-width="1.5"/>
                <circle cx="608" cy="100" r="7" fill="none" stroke="#9ca3af" stroke-width="1.5"/>
                <circle cx="608" cy="140" r="7" fill="none" stroke="#eab308" stroke-width="1.5"/>
                <circle cx="608" cy="180" r="7" fill="none" stroke="#3b82f6" stroke-width="1.5"/>
                <circle cx="608" cy="300" r="7" fill="none" stroke="#22c55e" stroke-width="1.5"/>
              </svg>
            </div>

            <!-- Single compact wiring legend row inside the card -->
            <div class="wire-legend-strip-compact">
              <span class="wire-legend-item"><span class="wire-legend-dot" style="background-color: #ef4444;"></span><span>3V3</span></span>
              <span class="wire-legend-item"><span class="wire-legend-dot" style="background-color: #64748b;"></span><span>GND</span></span>
              <span class="wire-legend-item"><span class="wire-legend-dot" style="background-color: #22c55e;"></span><span>DATA (G4)</span></span>
              <span class="wire-legend-item"><span class="wire-legend-dot" style="background-color: #3b82f6;"></span><span>SDA (G21)</span></span>
              <span class="wire-legend-item"><span class="wire-legend-dot" style="background-color: #eab308;"></span><span>SCL (G22)</span></span>
            </div>
          </article>

          <!-- Dynamic Translucent Wedge Connector SVG Overlay -->
          <svg id="zoomConnectorSvg" class="zoom-connector-svg" aria-hidden="true">
            <polygon id="zoomWedge" class="zoom-wedge-polygon" />
          </svg>
        </div>

        <!-- ROW 2: Graphs panel (Takes remaining height, min-height 220px) -->
        <article class="chart-card sim-charts-card">
          <div class="chart-header">
            <div class="chart-titles">
              <h2>Live Telemetry</h2>
            </div>
            <div class="chart-legend-custom">
              <span class="legend-item"><span class="legend-line" style="background-color: var(--chart-local-temp, #ea580c);"></span> Temp (°C)</span>
              <span class="legend-item"><span class="legend-line dashed" style="border-color: #7c3aed;"></span> Heat Index (°C)</span>
              <span class="legend-item"><span class="legend-line" style="background-color: var(--chart-local-rh, #167a3f);"></span> Humidity (%)</span>
            </div>
          </div>
          <div class="chart-container-wrapper sim-chart-wrapper">
            <div id="simChartEmptyState" class="chart-empty-state">Power on the device to start recording</div>
            <canvas id="simTelemetryChart"></canvas>
          </div>
        </article>
      </div>
    `;
  }

  /**
   * Binds interactive UI events and controls inside the diagram to global deviceStore.
   */
  bindEvents() {
    // 1. Power On/Off Toggle Button inside diagram header
    const btnPower = this.container.querySelector("#btnPowerToggle");
    if (btnPower) {
      btnPower.addEventListener("click", () => {
        deviceStore.togglePower();
      });
    }

    // 2. Speed Selector (1s, 2s, 5s) inside diagram header
    const speedButtons = this.container.querySelectorAll(".speed-btn");
    speedButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const speedMs = parseInt(btn.getAttribute("data-speed"), 10) || 2000;
        deviceStore.setRate(speedMs);
      });
    });
  }
}
