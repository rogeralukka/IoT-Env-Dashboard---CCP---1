import asyncio
import os
from playwright.async_api import async_playwright

ARTIFACTS_DIR = "C:/Users/Roger/.gemini/antigravity/brain/7e7b9aaa-8e0f-4832-bfd9-e125ce8b37e6"

async def run():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        context = await browser.new_context(viewport={'width': 1440, 'height': 900})
        page = await context.new_page()

        console_errors = []
        page.on("console", lambda msg: console_errors.append(f"[{msg.type}] {msg.text}") if msg.type in ["error", "warning"] else None)
        page.on("pageerror", lambda err: console_errors.append(f"[pageerror] {err}"))

        # --- 1. WEB MODE: LIGHT THEME ---
        await page.goto("http://127.0.0.1:8000/?mode=web", wait_until="networkidle")
        await page.evaluate("""() => {
            document.documentElement.setAttribute('data-theme', 'light');
            localStorage.setItem('dashboard_theme', 'light');
            window.scrollTo(0, 0);
        }""")
        await page.wait_for_timeout(800)
        await page.screenshot(path=os.path.join(ARTIFACTS_DIR, "web_light_scroll0.png"))
        print("Captured: web_light_scroll0.png")

        # Scroll to 300px
        await page.evaluate("() => window.scrollTo(0, 300)")
        await page.wait_for_timeout(600)
        await page.screenshot(path=os.path.join(ARTIFACTS_DIR, "web_light_scroll300.png"))
        print("Captured: web_light_scroll300.png")

        # --- 2. WEB MODE: DARK THEME ---
        await page.evaluate("""() => {
            document.documentElement.setAttribute('data-theme', 'dark');
            localStorage.setItem('dashboard_theme', 'dark');
            window.scrollTo(0, 0);
        }""")
        await page.wait_for_timeout(800)
        await page.screenshot(path=os.path.join(ARTIFACTS_DIR, "web_dark_scroll0.png"))
        print("Captured: web_dark_scroll0.png")

        # Scroll to 300px
        await page.evaluate("() => window.scrollTo(0, 300)")
        await page.wait_for_timeout(600)
        await page.screenshot(path=os.path.join(ARTIFACTS_DIR, "web_dark_scroll300.png"))
        print("Captured: web_dark_scroll300.png")

        # --- 3. SIMULATION MODE: LIGHT THEME ---
        await page.goto("http://127.0.0.1:8000/?mode=simulation", wait_until="networkidle")
        await page.evaluate("""() => {
            document.documentElement.setAttribute('data-theme', 'light');
            localStorage.setItem('dashboard_theme', 'light');
            window.scrollTo(0, 0);
        }""")
        await page.wait_for_timeout(800)
        await page.screenshot(path=os.path.join(ARTIFACTS_DIR, "sim_light_scroll0.png"))
        print("Captured: sim_light_scroll0.png")

        # Scroll to 300px
        await page.evaluate("() => window.scrollTo(0, 300)")
        await page.wait_for_timeout(600)
        await page.screenshot(path=os.path.join(ARTIFACTS_DIR, "sim_light_scroll300.png"))
        print("Captured: sim_light_scroll300.png")

        # --- 4. SIMULATION MODE: DARK THEME ---
        await page.evaluate("""() => {
            document.documentElement.setAttribute('data-theme', 'dark');
            localStorage.setItem('dashboard_theme', 'dark');
            window.scrollTo(0, 0);
        }""")
        await page.wait_for_timeout(800)
        await page.screenshot(path=os.path.join(ARTIFACTS_DIR, "sim_dark_scroll0.png"))
        print("Captured: sim_dark_scroll0.png")

        # Scroll to 300px
        await page.evaluate("() => window.scrollTo(0, 300)")
        await page.wait_for_timeout(600)
        await page.screenshot(path=os.path.join(ARTIFACTS_DIR, "sim_dark_scroll300.png"))
        print("Captured: sim_dark_scroll300.png")

        print("Total console issues:", len(console_errors))
        for err in console_errors[:10]:
            print("  ", err)

        await browser.close()

asyncio.run(run())
