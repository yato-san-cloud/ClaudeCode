import time, pathlib
from playwright.sync_api import sync_playwright

CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
OUT = pathlib.Path("design_handoff/screenshots")
URL = "http://127.0.0.1:8501"

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME, headless=True,
                                args=["--no-sandbox", "--disable-gpu"])
    # iPhone-ish portrait
    page = browser.new_page(viewport={"width": 390, "height": 844},
                            device_scale_factor=3, is_mobile=True)
    page.goto(URL, wait_until="networkidle", timeout=60000)
    time.sleep(3)
    # open sidebar (mobile: hamburger) to reach the sample button
    try:
        page.get_by_label("Open sidebar").click(timeout=5000)
        time.sleep(1)
    except Exception:
        pass
    page.get_by_role("button", name="▶ サンプルデータで試す").first.click(timeout=30000)
    page.get_by_text("サンプルデータを表示中").first.wait_for(timeout=90000)
    time.sleep(4)
    # close sidebar so content fills the screen
    try:
        page.get_by_label("Close sidebar").click(timeout=4000)
        time.sleep(1)
    except Exception:
        pass
    page.screenshot(path=str(OUT / "m1_summary_mobile.png"), full_page=True)
    # peak tab on mobile
    page.locator('button[data-baseweb="tab"]', has_text="ピーク分析").first.click(timeout=20000)
    time.sleep(3.5)
    page.screenshot(path=str(OUT / "m2_peak_mobile.png"), full_page=True)
    print("mobile shots done")
    browser.close()
