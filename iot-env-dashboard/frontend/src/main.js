/**
 * Main Application Controller for IoT Environmental Dashboard.
 * Manages view mode switching (Web Interface vs Simulation),
 * theme toggling (Light vs Dark mode) with persistent localStorage state,
 * and real-time SSE stream listeners.
 */

import { WebMode } from "./modes/web/webMode.js?v=3.12.0";
import { SimulationMode } from "./modes/simulation/simulationMode.js?v=3.12.0";
import { apiClient } from "./api/client.js?v=3.12.0";
import { deviceStore } from "./services/deviceStore.js?v=3.12.0";

class App {
  constructor() {
    const urlParams = new URLSearchParams(window.location.search);
    const modeParam = urlParams.get("mode");
    // Requirement 2: Simulation is default on fresh page loads.
    // Do not restore last mode from localStorage. Keep deep links like ?mode=web working.
    this.currentMode = (modeParam === "web" || modeParam === "simulation") ? modeParam : "simulation";
    this.currentTheme = localStorage.getItem("dashboard_theme") ||
      (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    this.activeModeInstance = null;

    this.modeContainer = document.getElementById("modeContainer");
    this.modeToggleWeb = document.getElementById("modeToggleWeb");
    this.modeToggleSim = document.getElementById("modeToggleSim");

    this.themeToggleBtn = document.getElementById("themeToggleBtn");
    this.themeIconSun = document.getElementById("themeIconSun");
    this.themeIconMoon = document.getElementById("themeIconMoon");

    this.init();
  }

  init() {
    this.setupStickyHeader();
    this.applyTheme(this.currentTheme);
    this.bindEvents();

    // Initialize global device store singleton outside views
    deviceStore.init();

    this.switchMode(this.currentMode);
    try {
      this.setupTelemetryStream();
    } catch (e) {
      console.warn("Telemetry stream error on init:", e);
    }
  }

  /**
   * Sets up zero-scroll-event IntersectionObserver for sticky header blur/border transition.
   * Triggered cleanly when user scrolls > ~8px past the 1px #scrollSentinel.
   */
  setupStickyHeader() {
    const sentinel = document.getElementById("scrollSentinel");
    const header = document.querySelector(".app-header");
    if (!sentinel || !header) return;

    const updateScrolledState = () => {
      if (window.scrollY > 8) {
        header.classList.add("is-scrolled");
      } else {
        header.classList.remove("is-scrolled");
      }
    };

    updateScrolledState();

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            header.classList.remove("is-scrolled");
          } else {
            header.classList.add("is-scrolled");
          }
        });
      },
      {
        root: null,
        threshold: 0,
      }
    );

    observer.observe(sentinel);
    window.addEventListener("scroll", updateScrolledState, { passive: true });
  }

  bindEvents() {
    if (this.modeToggleWeb) {
      this.modeToggleWeb.addEventListener("click", () => this.switchMode("web"));
    }
    if (this.modeToggleSim) {
      this.modeToggleSim.addEventListener("click", () => this.switchMode("simulation"));
    }

    if (this.themeToggleBtn) {
      this.themeToggleBtn.addEventListener("click", () => {
        const newTheme = this.currentTheme === "dark" ? "light" : "dark";
        this.applyTheme(newTheme);
      });
    }
  }

  /**
   * Applies and toggles between Light and Dark themes.
   * @param {'light'|'dark'} theme
   */
  applyTheme(theme) {
    this.currentTheme = theme;
    localStorage.setItem("dashboard_theme", theme);
    document.documentElement.setAttribute("data-theme", theme);

    if (this.themeIconSun && this.themeIconMoon) {
      if (theme === "dark") {
        // When in dark mode, show sun icon to allow switching to light
        this.themeIconSun.style.display = "block";
        this.themeIconMoon.style.display = "none";
        this.themeToggleBtn.setAttribute("title", "Switch to Light mode");
        this.themeToggleBtn.setAttribute("aria-label", "Switch to Light mode");
      } else {
        // When in light mode, show moon icon to allow switching to dark
        this.themeIconSun.style.display = "none";
        this.themeIconMoon.style.display = "block";
        this.themeToggleBtn.setAttribute("title", "Switch to Dark mode");
        this.themeToggleBtn.setAttribute("aria-label", "Switch to Dark mode");
      }
    }

    // Notify active mode to re-render or update chart color palettes
    if (this.activeModeInstance && typeof this.activeModeInstance.onThemeChange === "function") {
      this.activeModeInstance.onThemeChange(theme);
    }
  }

  /**
   * Switches views between Mode 1 (Web Interface) and Mode 2 (Simulation).
   * @param {'web'|'simulation'} mode
   */
  switchMode(mode) {
    if (this.activeModeInstance && typeof this.activeModeInstance.destroy === "function") {
      this.activeModeInstance.destroy();
    }

    this.currentMode = mode;
    // Do not persist mode to localStorage (fresh load always defaults to Simulation)
    document.body.classList.toggle("mode-simulation-active", mode === "simulation");

    // Update pill toggle visual buttons
    if (mode === "web") {
      if (this.modeToggleWeb) {
        this.modeToggleWeb.classList.add("active");
        this.modeToggleWeb.setAttribute("aria-pressed", "true");
      }
      if (this.modeToggleSim) {
        this.modeToggleSim.classList.remove("active");
        this.modeToggleSim.setAttribute("aria-pressed", "false");
      }

      this.activeModeInstance = new WebMode(this.modeContainer);
      this.activeModeInstance.init();
    } else {
      if (this.modeToggleSim) {
        this.modeToggleSim.classList.add("active");
        this.modeToggleSim.setAttribute("aria-pressed", "true");
      }
      if (this.modeToggleWeb) {
        this.modeToggleWeb.classList.remove("active");
        this.modeToggleWeb.setAttribute("aria-pressed", "false");
      }

      this.activeModeInstance = new SimulationMode(this.modeContainer);
      this.activeModeInstance.init();
    }
  }

  /**
   * Establishes real-time SSE telemetry connection to Virtual AWS backend.
   */
  setupTelemetryStream() {
    apiClient.connectStream({
      onReading: (packet) => {
        // If web mode is active, pass packet to update comparison chart
        if (this.currentMode === "web" && this.activeModeInstance && this.activeModeInstance.handleLocalSensorPacket) {
          this.activeModeInstance.handleLocalSensorPacket(packet);
        }
      },
      onAlarm: (alarmEvent) => {
        console.log("CloudWatch Alarm State Change Event:", alarmEvent);
      },
      onStatusChange: (status) => {
        console.log("SSE Stream Status:", status);
      },
    });
  }
}

// Bootstrap reliably whether document is still loading or already parsed
function bootstrap() {
  try {
    window.__IOT_APP__ = new App();
    console.log("IoT Environmental Dashboard initialized successfully.");
  } catch (err) {
    console.error("Initialization error:", err);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}
