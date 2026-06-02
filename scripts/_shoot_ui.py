import sys, time, pathlib
from playwright.sync_api import sync_playwright

CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
OUT = pathlib.Path("design_handoff/screenshots")
OUT.mkdir(parents=True, exist_ok=True)
URL = "http://127.0.0.1:8501"

TABS = [
    ("01_summary", "📊 サマリー"),
    ("02_trend", "📈 物量推移"),
    ("03_abc", "🏷️ ABC 分析"),
    ("04_peak", "⏰ ピーク分析"),
    ("05_inventory", "🔄 在庫回転"),
    ("06_forecast", "🔮 予測"),
    ("07_portfolio", "🧬 SKUポートフォリオ"),
    ("08_compare", "🔁 期間対比"),
]

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROME, headless=True,
                                    args=["--no-sandbox", "--disable-gpu"])
        page = browser.new_page(viewport={"width": 1440, "height": 2200},
                                device_scale_factor=2)
        page.goto(URL, wait_until="networkidle", timeout=60000)
        time.sleep(3)

        # Click "サンプルデータで試す" in the sidebar.
        btn = page.get_by_role("button", name="▶ サンプルデータで試す")
        btn.first.click(timeout=30000)
        # Wait for the sample to load (success badge appears).
        page.get_by_text("サンプルデータを表示中").first.wait_for(timeout=90000)
        time.sleep(4)

        # Capture sidebar-open landing first.
        page.screenshot(path=str(OUT / "00_landing_sidebar.png"), full_page=True)

        for fname, label in TABS:
            tab = page.locator('button[data-baseweb="tab"]', has_text=label.split(" ", 1)[1])
            tab.first.click(timeout=20000)
            time.sleep(3.5)  # let plotly/altair render
            page.screenshot(path=str(OUT / f"{fname}.png"), full_page=True)
            print("captured", fname)

        browser.close()

if __name__ == "__main__":
    main()
