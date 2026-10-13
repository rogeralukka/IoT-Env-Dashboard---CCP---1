/**
 * API Client for IoT Environmental Dashboard.
 * Interacts with FastAPI virtual AWS backend:
 * - GET  /api/weather?city=...
 * - GET  /api/stream (Server-Sent Events)
 * - POST /api/device/publish
 * - GET  /api/cloud/*
 * - GET  /api/export?format=...
 */

export class ApiClient {
  constructor(baseUrl = "") {
    this.baseUrl = baseUrl;
    this.eventSource = null;
    this.streamListeners = {
      reading: [],
      alarm: [],
      ping: [],
      statusChange: [],
    };
  }

  /**
   * Fetches weather data for a specified city or GPS coordinates.
   * @param {string|{city?: string, lat?: number, lon?: number}} query
   * @returns {Promise<object>}
   */
  async getWeather(query = "Hasanparthy (Hanamkonda)") {
    let url = `${this.baseUrl}/api/weather`;
    if (typeof query === "string") {
      url += `?city=${encodeURIComponent(query)}`;
    } else if (query && query.lat != null && query.lon != null) {
      url += `?lat=${encodeURIComponent(query.lat)}&lon=${encodeURIComponent(query.lon)}`;
    } else if (query && query.city) {
      url += `?city=${encodeURIComponent(query.city)}`;
    } else {
      url += `?city=Hasanparthy%20(Hanamkonda)`;
    }
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Weather fetch failed: ${response.status} ${response.statusText}`);
    }
    return await response.json();
  }

  /**
   * Starts Server-Sent Events (SSE) telemetry connection.
   * @param {object} callbacks - { onReading, onAlarm, onPing, onStatusChange }
   */
  connectStream(callbacks = {}) {
    if (this.eventSource) {
      this.eventSource.close();
    }

    const streamUrl = `${this.baseUrl}/api/stream`;
    this.eventSource = new EventSource(streamUrl);

    if (callbacks.onStatusChange) {
      callbacks.onStatusChange("connecting");
    }

    this.eventSource.onopen = () => {
      if (callbacks.onStatusChange) {
        callbacks.onStatusChange("connected");
      }
    };

    this.eventSource.addEventListener("init", (event) => {
      try {
        const data = JSON.parse(event.data);
        if (callbacks.onInit) callbacks.onInit(data);
      } catch (err) {
        console.error("Error parsing init event:", err);
      }
    });

    this.eventSource.addEventListener("reading", (event) => {
      try {
        const data = JSON.parse(event.data);
        if (callbacks.onReading) callbacks.onReading(data);
      } catch (err) {
        console.error("Error parsing reading event:", err);
      }
    });

    this.eventSource.addEventListener("alarm", (event) => {
      try {
        const data = JSON.parse(event.data);
        if (callbacks.onAlarm) callbacks.onAlarm(data);
      } catch (err) {
        console.error("Error parsing alarm event:", err);
      }
    });

    this.eventSource.addEventListener("ping", (event) => {
      try {
        const data = JSON.parse(event.data);
        if (callbacks.onPing) callbacks.onPing(data);
      } catch (err) {
        console.error("Error parsing ping event:", err);
      }
    });

    this.eventSource.onerror = (err) => {
      console.warn("SSE stream error or disconnected, browser will auto-reconnect:", err);
      if (callbacks.onStatusChange) {
        callbacks.onStatusChange("disconnected");
      }
    };
  }

  /**
   * Closes active SSE stream.
   */
  disconnectStream() {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  /**
   * Posts simulated telemetry packet to AWS IoT Core bridge.
   * @param {object} packet
   * @returns {Promise<object>}
   */
  async publishTelemetry(packet) {
    const response = await fetch(`${this.baseUrl}/api/device/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(packet),
    });
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.detail || `Publish failed: ${response.status}`);
    }
    return await response.json();
  }

  /**
   * Fetches AWS Cloud auditing state.
   * @param {string} service - 'messages' | 's3' | 'lambda' | 'alarms'
   */
  async getCloudStatus(service) {
    const response = await fetch(`${this.baseUrl}/api/cloud/${service}`);
    if (!response.ok) {
      throw new Error(`Cloud audit fetch failed: ${response.status}`);
    }
    return await response.json();
  }

  /**
   * Gets download URL for S3 datalake export.
   * @param {'csv'|'json'} format
   */
  getExportUrl(format = "csv") {
    return `${this.baseUrl}/api/export?format=${format}`;
  }

  /**
   * Resets virtual AWS services and clears session counters.
   */
  async resetCloudSession() {
    const response = await fetch(`${this.baseUrl}/api/cloud/reset`, {
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(`Reset failed: ${response.status}`);
    }
    return await response.json();
  }
}

export const apiClient = new ApiClient();
