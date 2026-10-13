import asyncio
from playwright.async_api import async_playwright

async def run():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        context = await browser.new_context(viewport={'width': 1440, 'height': 900})
        page = await context.new_page()

        console_errors = []
        page.on("console", lambda msg: console_errors.append(f"[{msg.type}] {msg.text}") if msg.type in ["error", "warning"] else None)
        page.on("pageerror", lambda err: console_errors.append(f"[pageerror] {err}"))

        # 1. Simulation Mode - Light
        await page.goto("http://127.0.0.1:8000/?mode=simulation", wait_until="networkidle")
        await page.wait_for_timeout(2000)
        await page.screenshot(path="C:/Users/Roger/.gemini/antigravity/brain/7e7b9aaa-8e0f-4832-bfd9-e125ce8b37e6/sim_light_redesigned.png", full_page=True)
        print("Captured: sim_light_redesigned.png")

        # 2. Simulation Mode - Dark
        await page.evaluate("""() => {
            document.documentElement.setAttribute('data-theme', 'dark');
            localStorage.setItem('dashboard_theme', 'dark');
            const event = new CustomEvent('themechange', { detail: { theme: 'dark' } });
            window.dispatchEvent(event);
        }""")
        await page.wait_for_timeout(1000)
        await page.screenshot(path="C:/Users/Roger/.gemini/antigravity/brain/7e7b9aaa-8e0f-4832-bfd9-e125ce8b37e6/sim_dark_redesigned.png", full_page=True)
        print("Captured: sim_dark_redesigned.png")

        # 3. Web Interface Mode - Light
        await page.goto("http://127.0.0.1:8000/?mode=web", wait_until="networkidle")
        await page.evaluate("""() => {
            document.documentElement.setAttribute('data-theme', 'light');
            localStorage.setItem('dashboard_theme', 'light');
        }""")
        await page.wait_for_timeout(2000)
        await page.screenshot(path="C:/Users/Roger/.gemini/antigravity/brain/7e7b9aaa-8e0f-4832-bfd9-e125ce8b37e6/web_light_verified.png", full_page=True)
        print("Captured: web_light_verified.png")

        # 4. Web Interface Mode - Dark
        await page.evaluate("""() => {
            document.documentElement.setAttribute('data-theme', 'dark');
            localStorage.setItem('dashboard_theme', 'dark');
        }""")
        await page.wait_for_timeout(1000)
        await page.screenshot(path="C:/Users/Roger/.gemini/antigravity/brain/7e7b9aaa-8e0f-4832-bfd9-e125ce8b37e6/web_dark_verified.png", full_page=True)
        print("Captured: web_dark_verified.png")

        print("Console issues found:", len(console_errors))
        for err in console_errors[:10]:
            print("  ", err)

        await browser.close()

asyncio.run(run())
