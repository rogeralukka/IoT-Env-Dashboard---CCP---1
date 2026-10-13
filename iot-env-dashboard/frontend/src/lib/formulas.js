/**
 * Psychrometric and Environmental Metric Formulas.
 * Client-side calculations matching backend AWS Lambda ProcessEnvironmentalData:
 * 1. Dew Point (Magnus-Tetens)
 * 2. Absolute Humidity (g/m3)
 * 3. Heat Index (Rothfusz Regression with NWS Adjustments)
 * 4. Comfort & Hazard Categorization
 */

/**
 * Calculates Dew Point in Celsius using the Magnus-Tetens formula.
 * a = 17.62, b = 243.12
 * gamma = ln(RH / 100) + (a * T) / (b + T)
 * Td = (b * gamma) / (a - gamma)
 * @param {number} tempC - Temperature in Celsius
 * @param {number} humidityPct - Relative Humidity percentage (0-100)
 * @returns {number} Dew Point in Celsius
 */
export function calculateDewPoint(tempC, humidityPct) {
  const rh = Math.max(Math.min(humidityPct, 100), 0.1);
  const a = 17.62;
  const b = 243.12;
  const gamma = Math.log(rh / 100) + (a * tempC) / (b + tempC);
  const td = (b * gamma) / (a - gamma);
  return Math.round(td * 10) / 10;
}

/**
 * Calculates Absolute Humidity in grams per cubic meter (g/m3).
 * AH = 6.112 * exp(17.67 * T / (T + 243.5)) * RH * 2.1674 / (273.15 + T)
 * @param {number} tempC - Temperature in Celsius
 * @param {number} humidityPct - Relative Humidity percentage (0-100)
 * @returns {number} Absolute humidity in g/m3
 */
export function calculateAbsoluteHumidity(tempC, humidityPct) {
  const rh = Math.max(Math.min(humidityPct, 100), 0);
  const numerator = 6.112 * Math.exp((17.67 * tempC) / (tempC + 243.5)) * rh * 2.1674;
  const denominator = 273.15 + tempC;
  const ah = numerator / denominator;
  return Math.round(ah * 10) / 10;
}

/**
 * Calculates Heat Index in Celsius using the full Rothfusz regression algorithm
 * with National Weather Service (NWS) low- and high-humidity adjustments.
 * @param {number} tempC - Temperature in Celsius
 * @param {number} humidityPct - Relative Humidity percentage (0-100)
 * @returns {number} Heat Index in Celsius
 */
export function calculateHeatIndex(tempC, humidityPct) {
  const f = tempC * 1.8 + 32;
  const rh = Math.max(Math.min(humidityPct, 100), 0);

  // Simple formula first
  const hiSimple = 0.5 * (f + 61.0 + (f - 68.0) * 1.2 + rh * 0.094);
  const hiAvg = 0.5 * (hiSimple + f);

  let hiF = hiAvg;

  if (hiAvg >= 80.0) {
    // Full Rothfusz regression equation
    const c1 = -42.379;
    const c2 = 2.04901523;
    const c3 = 10.14333127;
    const c4 = -0.22475541;
    const c5 = -6.83783e-3;
    const c6 = -5.481717e-2;
    const c7 = 1.22874e-3;
    const c8 = 8.5282e-4;
    const c9 = -1.99e-6;

    hiF =
      c1 +
      c2 * f +
      c3 * rh +
      c4 * f * rh +
      c5 * f * f +
      c6 * rh * rh +
      c7 * f * f * rh +
      c8 * f * rh * rh +
      c9 * f * f * rh * rh;

    // Adjustment 1: Low humidity (RH < 13% and 80 <= F <= 112)
    if (rh < 13 && f >= 80 && f <= 112) {
      const adj = -((13 - rh) / 4) * Math.sqrt((17 - Math.abs(f - 95)) / 17);
      hiF += adj;
    }
    // Adjustment 2: High humidity (RH > 85% and 80 <= F <= 87)
    else if (rh > 85 && f >= 80 && f <= 87) {
      const adj = ((rh - 85) / 10) * ((87 - f) / 5);
      hiF += adj;
    }
  }

  // Convert back to Celsius
  const hiC = (hiF - 32) * (5 / 9);
  return Math.round(hiC * 10) / 10;
}

/**
 * Converts Celsius to Fahrenheit.
 * @param {number} tempC - Temperature in Celsius
 * @returns {number} Temperature in Fahrenheit
 */
export function celsiusToFahrenheit(tempC) {
  return Math.round((tempC * 1.8 + 32) * 10) / 10;
}

/**
 * Classifies Heat Index into standard danger categories:
 * - Normal: <= 31 C
 * - Caution: 32 C to 41 C (Fatigue with prolonged exposure)
 * - Danger: > 41 C (Heat cramps, exhaustion or heat stroke likely)
 * @param {number} hiC - Heat Index in Celsius
 * @returns {{ label: string, level: string, colorClass: string }}
 */
export function getHeatIndexCategory(hiC) {
  if (hiC > 41.0) {
    return { label: "Danger", level: "danger", colorClass: "badge-danger" };
  }
  if (hiC >= 32.0) {
    return { label: "Caution", level: "caution", colorClass: "badge-caution" };
  }
  return { label: "Normal", level: "normal", colorClass: "badge-normal" };
}

/**
 * Classifies Dew Point into human comfort categories:
 * - Dry: < 10 C (Dry, crisp air)
 * - Comfortable: 10 C to 18 C (Pleasant comfort zone)
 * - Humid: > 18 C (Sticky, oppressive humidity)
 * @param {number} dpC - Dew Point in Celsius
 * @returns {{ label: string, level: string, colorClass: string }}
 */
export function getDewPointComfortCategory(dpC) {
  if (dpC < 10.0) {
    return { label: "Dry", level: "dry", colorClass: "badge-dry" };
  }
  if (dpC <= 18.0) {
    return { label: "Comfortable", level: "comfortable", colorClass: "badge-comfortable" };
  }
  return { label: "Humid", level: "humid", colorClass: "badge-humid" };
}
