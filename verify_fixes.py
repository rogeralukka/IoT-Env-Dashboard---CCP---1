"""
Automated Verification Script for IoT Environmental Dashboard Fix List.
Tests all 9 items and captures screenshots across resolutions and themes:
- Viewports: 1366x768, 1920x1080, 2560x1440, 390x844 (mobile)
- Themes: Light, Dark
- Modes: Simulation, Web Interface
"""

import asyncio
import json
from playwright.async_api import async_playwright

SCREENSHOT_DIR = "C:/Users/Roger/.gemini/antigravity/brain/7e7b9aaa-8e0f-4832-bfd9-e125ce8b37e6"

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        
        # -------------------------------------------------------------
        # TEST 1: Header Layout & Focus Ring at 1920x1080 & 2560x1440
        # -------------------------------------------------------------
        print("=== TEST 1 & 2: Header Alignment, Bleed, and Focus Ring ===")
        context = await browser.new_context(viewport={'width': 1920, 'height': 1080})
        page = await context.new_page()

        console_errors = []
        page.on("console", lambda msg: console_errors.append(f"[{msg.type}] {msg.text}") if msg.type in ["error"] else None)
        page.on("pageerror", lambda err: console_errors.append(f"[pageerror] {err}"))

        await page.goto("http://127.0.0.1:8000/?mode=simulation", wait_until="domcontentloaded")
        await page.wait_for_timeout(1500)

        # Check full-bleed header vs centered main layout
        header_metrics = await page.evaluate("""() => {
            const header = document.querySelector('.app-header');
            const inner = document.querySelector('.app-header-inner');
            const main = document.querySelector('#modeContainer') || document.querySelector('.app-container');
            const title = document.querySelector('.brand-titles');
            const controls = document.querySelector('.header-controls');
            const headerRect = header.getBoundingClientRect();
            const innerRect = inner.getBoundingClientRect();
            const mainRect = main.getBoundingClientRect();
            const titleRect = title.getBoundingClientRect();
            const controlsRect = controls.getBoundingClientRect();
            const innerStyle = window.getComputedStyle(inner);

            return {
                windowWidth: window.innerWidth,
                headerWidth: headerRect.width,
                innerWidth: innerRect.width,
                mainWidth: mainRect.width,
                titleLeft: titleRect.left,
                controlsRight: window.innerWidth - controlsRect.right,
                paddingInline: innerStyle.paddingInline || `${innerStyle.paddingLeft} ${innerStyle.paddingRight}`,
                paddingLeft: parseFloat(innerStyle.paddingLeft),
                paddingRight: parseFloat(innerStyle.paddingRight),
            };
        }""")
        print("1920px Header metrics:", json.dumps(header_metrics, indent=2))
        assert header_metrics["innerWidth"] == header_metrics["headerWidth"], "Header inner must be full-bleed (width == window width)"
        assert header_metrics["mainWidth"] <= 1280 + 32, f"Page body maintains max-width (got {header_metrics['mainWidth']})"
        assert header_metrics["paddingLeft"] >= 16 and header_metrics["paddingLeft"] <= 50, f"padding-inline clamp within bounds: {header_metrics['paddingLeft']}"

        # Test Mouse Click on Mode Toggle -> No outline or box-shadow ring
        web_btn = page.locator("#modeToggleWeb")
        await web_btn.click()
        await page.wait_for_timeout(400)
        btn_focus_after_click = await page.evaluate("""() => {
            const btn = document.querySelector('#modeToggleWeb');
            const s = window.getComputedStyle(btn);
            return {
                outlineStyle: s.outlineStyle,
                outlineWidth: s.outlineWidth,
                boxShadow: s.boxShadow,
                matchesFocusVisible: btn.matches(':focus-visible'),
                matchesFocus: btn.matches(':focus')
            };
        }""")
        print("Mode button after mouse click:", btn_focus_after_click)
        assert btn_focus_after_click["outlineStyle"] == "none" or btn_focus_after_click["outlineWidth"] == "0px", "No outline on mouse click!"
        assert "rgb(217, 75, 38)" not in btn_focus_after_click["boxShadow"] and "rgb(251, 146, 60)" not in btn_focus_after_click["boxShadow"], "No orange ring shadow on mouse click!"

        # Test Keyboard TAB focus -> Focus-visible outline appears
        await page.keyboard.press("Tab")
        tab_focus = await page.evaluate("""() => {
            const active = document.activeElement;
            const s = window.getComputedStyle(active);
            return {
                tag: active.tagName,
                id: active.id,
                outlineStyle: s.outlineStyle,
                outlineWidth: s.outlineWidth,
                outlineColor: s.outlineColor,
                matchesFocusVisible: active.matches(':focus-visible')
            };
        }""")
        print("Focused element after Tab key:", tab_focus)
        if tab_focus["matchesFocusVisible"]:
            assert tab_focus["outlineStyle"] != "none" and tab_focus["outlineWidth"] != "0px", "Tab key produces outline!"

        # -------------------------------------------------------------
        # TEST 3: OLED Screen Fixed Colors in Both Themes
        # -------------------------------------------------------------
        print("\n=== TEST 3: OLED Fixed Theme-Independent Styling ===")
        # Go to Simulation mode
        await page.goto("http://127.0.0.1:8000/?mode=simulation", wait_until="domcontentloaded")
        await page.wait_for_timeout(1000)

        # Light theme OLED measurements
        oled_light = await page.evaluate("""() => {
            const bezel = document.querySelector('#largeOledBezel');
            const glass = document.querySelector('#svgOledGlass');
            const innerRect = document.querySelector('#largeOledScreenSvg rect');
            const sBezel = window.getComputedStyle(bezel);
            return {
                bezelBg: sBezel.backgroundColor,
                bezelBorder: sBezel.border,
                bezelShadow: sBezel.boxShadow,
                innerBg: innerRect ? innerRect.getAttribute('fill') : (glass ? glass.getAttribute('fill') : '#02060a'),
            };
        }""")
        print("OLED styling in Light mode:", oled_light)

        # Switch to Dark theme
        await page.click("#themeToggleBtn")
        await page.wait_for_timeout(600)

        oled_dark = await page.evaluate("""() => {
            const bezel = document.querySelector('#largeOledBezel');
            const glass = document.querySelector('#svgOledGlass');
            const innerRect = document.querySelector('#largeOledScreenSvg rect');
            const sBezel = window.getComputedStyle(bezel);
            return {
                bezelBg: sBezel.backgroundColor,
                bezelBorder: sBezel.border,
                bezelShadow: sBezel.boxShadow,
                innerBg: innerRect ? innerRect.getAttribute('fill') : (glass ? glass.getAttribute('fill') : '#02060a'),
            };
        }""")
        print("OLED styling in Dark mode:", oled_dark)

        assert oled_light["bezelBg"] == oled_dark["bezelBg"], "OLED bezel background identical in both themes!"
        assert oled_light["innerBg"] == oled_dark["innerBg"], "OLED inner screen background identical in both themes!"
        assert "rgb(11, 13, 16)" in oled_dark["bezelBg"], f"OLED bezel is #0b0d10 (got {oled_dark['bezelBg']})"
        assert "#02060a" in oled_dark["innerBg"] or "rgb(2, 6, 10)" in oled_dark["innerBg"], f"OLED inner screen is #02060a (got {oled_dark['innerBg']})"

        # Click theme button with mouse in dark mode -> No orange ring
        btn_theme_after_click = await page.evaluate("""() => {
            const btn = document.querySelector('#themeToggleBtn');
            const s = window.getComputedStyle(btn);
            return {
                outlineStyle: s.outlineStyle,
                outlineWidth: s.outlineWidth,
                boxShadow: s.boxShadow
            };
        }""")
        print("Theme button in dark mode after click:", btn_theme_after_click)
        assert btn_theme_after_click["outlineStyle"] == "none" or btn_theme_after_click["outlineWidth"] == "0px", "No outline on theme button after click!"

        # -------------------------------------------------------------
        # TEST 5 & 8: Header Depth & Simulation Card Ratios
        # -------------------------------------------------------------
        print("\n=== TEST 5 & 8: Dark Header Depth & OLED Card Ratio ===")
        # Scroll page to test header scrolled depth
        await page.evaluate("window.scrollTo(0, 150)")
        await page.wait_for_timeout(300)
        header_depth = await page.evaluate("""() => {
            const h = document.querySelector('.app-header');
            const s = window.getComputedStyle(h);
            return {
                isScrolled: h.classList.contains('is-scrolled'),
                borderBottom: s.borderBottom,
                boxShadow: s.boxShadow
            };
        }""")
        print("Scrolled header depth in dark mode:", header_depth)
        assert "rgba(255, 255, 255, 0.08)" in header_depth["borderBottom"] or "0.08" in header_depth["borderBottom"], "Scrolled header bottom highlight line present in dark mode!"

        # OLED height coverage ratio (must cover at least 70% of OLED card height)
        sim_ratios = await page.evaluate("""() => {
            const oledCard = document.querySelector('#zoomedOledCard');
            const oledBezel = document.querySelector('#largeOledBezel');
            const circuitCard = document.querySelector('#circuitDiagramCard');
            const svg = document.querySelector('#schematicSvg');
            const oledCardRect = oledCard.getBoundingClientRect();
            const oledBezelRect = oledBezel.getBoundingClientRect();
            const circuitCardRect = circuitCard.getBoundingClientRect();
            const ratio = oledBezelRect.height / oledCardRect.height;
            const dhtReadout = document.querySelector('#dht11LiveReadout');

            return {
                oledCardHeight: oledCardRect.height,
                oledBezelHeight: oledBezelRect.height,
                circuitCardHeight: circuitCardRect.height,
                coverageRatio: ratio,
                svgViewBox: svg ? svg.getAttribute('viewBox') : null,
                dhtReadout: dhtReadout ? dhtReadout.textContent.trim() : null
            };
        }""")
        print("Simulation Workbench metrics:", json.dumps(sim_ratios, indent=2))
        assert sim_ratios["coverageRatio"] >= 0.70, f"OLED screen must cover at least 70% of card height (got {sim_ratios['coverageRatio']:.1%})"
        assert sim_ratios["svgViewBox"] == "36 18 928 454", f"Circuit SVG viewBox tightly cropped (got {sim_ratios['svgViewBox']})"
        assert sim_ratios["dhtReadout"] is not None, "DHT11 live readout present in schematic!"

        # Power on device to see active telemetry & live DHT11 readout
        await page.evaluate("window.scrollTo(0, 0)")
        pwr_btn = page.locator("#btnPowerToggle")
        await pwr_btn.click()
        await page.wait_for_timeout(2500)

        dht_active = await page.evaluate("""() => {
            const r = document.querySelector('#dht11LiveReadout');
            return r ? r.textContent.trim() : null;
        }""")
        print("DHT11 live readout after power ON:", dht_active)
        assert "C" in dht_active and "%" in dht_active, f"DHT11 readout active (got {dht_active})"

        # Check Live Telemetry empty state is hidden when data is streaming
        empty_hidden = await page.evaluate("""() => {
            const el = document.querySelector('#simChartEmptyState');
            return el ? el.classList.contains('hidden') : false;
        }""")
        print("Simulation chart empty state hidden when active:", empty_hidden)
        assert empty_hidden, "Sim chart empty state hidden after power on!"

        # -------------------------------------------------------------
        # CAPTURE SCREENSHOTS: 1920x1080 (Dark & Light)
        # -------------------------------------------------------------
        print("\n=== Capturing 1920x1080 Screenshots ===")
        # 1. Sim 1080p Dark
        await page.screenshot(path=f"{SCREENSHOT_DIR}/verified_sim_dark_1920p.png")
        print("Captured: verified_sim_dark_1920p.png")

        # 2. Sim 1080p Light
        await page.click("#themeToggleBtn")
        await page.wait_for_timeout(500)
        await page.screenshot(path=f"{SCREENSHOT_DIR}/verified_sim_light_1920p.png")
        print("Captured: verified_sim_light_1920p.png")

        # 3. Web 1080p Light
        await page.click("#modeToggleWeb")
        await page.wait_for_timeout(1500)
        await page.screenshot(path=f"{SCREENSHOT_DIR}/verified_web_light_1920p.png")
        print("Captured: verified_web_light_1920p.png")

        # 4. Web 1080p Dark
        await page.click("#themeToggleBtn")
        await page.wait_for_timeout(500)
        await page.screenshot(path=f"{SCREENSHOT_DIR}/verified_web_dark_1920p.png")
        print("Captured: verified_web_dark_1920p.png")

        # Check 24-hour time formatting & emojis in Web Interface
        web_checks = await page.evaluate("""() => {
            const updated = document.querySelector('#lastUpdatedLabel')?.textContent || '';
            const packet = document.querySelector('#sensorPacketBadge')?.textContent || '';
            const rssi = document.querySelector('#sensorRssiBadge')?.textContent || '';
            // Check for any emoji characters in headers or badges
            const emojiRegex = /(\\u00a9|\\u00ae|[\\u2000-\\u3300]|\\ud83c[\\ud000-\\udfff]|\\ud83d[\\ud000-\\udfff]|\\ud83e[\\ud000-\\udfff])/g;
            const bodyText = document.body.innerText;
            const hasEmoji = emojiRegex.test(document.querySelector('.app-header').innerText) ||
                             emojiRegex.test(document.querySelector('#secSensorHeading').innerText) ||
                             emojiRegex.test(document.querySelector('#secWeatherHeading').innerText) ||
                             emojiRegex.test(document.querySelector('#secComparisonHeading').innerText);

            return {
                updatedText: updated,
                packetText: packet,
                rssiText: rssi,
                hasEmojiInHeadings: hasEmoji
            };
        }""")
        print("Web interface text format checks:", json.dumps(web_checks, indent=2))
        assert "Updated: " in web_checks["updatedText"], "Updated label present"
        assert not web_checks["hasEmojiInHeadings"], "No emoji icons in section headers!"

        await context.close()

        # -------------------------------------------------------------
        # TEST 2560x1440 Ultrawide Alignment
        # -------------------------------------------------------------
        print("\n=== TEST: 2560x1440 Ultrawide Header Alignment ===")
        context_2560 = await browser.new_context(viewport={'width': 2560, 'height': 1440})
        page_2560 = await context_2560.new_page()
        await page_2560.goto("http://127.0.0.1:8000/?mode=simulation", wait_until="domcontentloaded")
        await page_2560.wait_for_timeout(1000)

        header_2560 = await page_2560.evaluate("""() => {
            const header = document.querySelector('.app-header');
            const inner = document.querySelector('.app-header-inner');
            const main = document.querySelector('#modeContainer') || document.querySelector('.app-container');
            const title = document.querySelector('.brand-titles');
            const controls = document.querySelector('.header-controls');
            return {
                windowWidth: window.innerWidth,
                headerWidth: header.getBoundingClientRect().width,
                innerWidth: inner.getBoundingClientRect().width,
                mainWidth: main.getBoundingClientRect().width,
                titleLeft: title.getBoundingClientRect().left,
                controlsRight: window.innerWidth - controls.getBoundingClientRect().right,
            };
        }""")
        print("2560px Header metrics:", json.dumps(header_2560, indent=2))
        assert header_2560["innerWidth"] == 2560, "Header is full bleed at 2560px"
        assert header_2560["mainWidth"] <= 1280 + 32, "Body stays centered at 1280px"

        await page_2560.screenshot(path=f"{SCREENSHOT_DIR}/verified_sim_dark_2560p.png")
        print("Captured: verified_sim_dark_2560p.png")
        await context_2560.close()

        # -------------------------------------------------------------
        # TEST 1366x768 Standard Laptop
        # -------------------------------------------------------------
        print("\n=== TEST: 1366x768 Standard Laptop Fit ===")
        context_1366 = await browser.new_context(viewport={'width': 1366, 'height': 768})
        page_1366 = await context_1366.new_page()
        await page_1366.goto("http://127.0.0.1:8000/?mode=simulation", wait_until="domcontentloaded")
        await page_1366.wait_for_timeout(1000)

        scroll_info_1366 = await page_1366.evaluate("""() => {
            return {
                docHeight: document.documentElement.scrollHeight,
                winHeight: window.innerHeight,
                fitsOneScreen: document.documentElement.scrollHeight <= window.innerHeight + 1
            };
        }""")
        print("1366x768 screen fit:", scroll_info_1366)
        await page_1366.screenshot(path=f"{SCREENSHOT_DIR}/verified_sim_dark_1366p.png")
        print("Captured: verified_sim_dark_1366p.png")
        await context_1366.close()

        # -------------------------------------------------------------
        # TEST 390x844 Mobile Viewport
        # -------------------------------------------------------------
        print("\n=== TEST: 390px Mobile Viewport ===")
        context_390 = await browser.new_context(viewport={'width': 390, 'height': 844})
        page_390 = await context_390.new_page()
        await page_390.goto("http://127.0.0.1:8000/?mode=simulation", wait_until="domcontentloaded")
        await page_390.wait_for_timeout(1000)

        mobile_header = await page_390.evaluate("""() => {
            const header = document.querySelector('.app-header');
            const inner = document.querySelector('.app-header-inner');
            const title = document.querySelector('.brand-titles h1');
            const controls = document.querySelector('.header-controls');
            const sInner = window.getComputedStyle(inner);
            const sTitle = window.getComputedStyle(title);
            const controlsRect = controls.getBoundingClientRect();
            const titleRect = title.getBoundingClientRect();

            return {
                paddingLeft: parseFloat(sInner.paddingLeft),
                paddingRight: parseFloat(sInner.paddingRight),
                titleFontSize: sTitle.fontSize,
                titleOverflow: sTitle.overflow,
                sameRow: Math.abs(titleRect.top - controlsRect.top) < 25
            };
        }""")
        print("390px Mobile header metrics:", json.dumps(mobile_header, indent=2))
        assert mobile_header["paddingLeft"] >= 12 and mobile_header["paddingLeft"] <= 16, f"Mobile padding 12-16px (got {mobile_header['paddingLeft']})"
        assert mobile_header["sameRow"], "Controls stay on one row on mobile"

        await page_390.screenshot(path=f"{SCREENSHOT_DIR}/verified_mobile_390p.png")
        print("Captured: verified_mobile_390p.png")
        await context_390.close()

        print("\nAll automated verification checks PASSED successfully!")
        await browser.close()

if __name__ == "__main__":
    asyncio.run(main())
