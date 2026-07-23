"""デスクトップアプリとしての起動エントリポイント。

Flask サーバーをバックグラウンドスレッドで立ち上げ、pywebview の
ネイティブウィンドウで開く。ブラウザもターミナルも不要、
ダブルクリックで起動できる "アプリ" として振る舞う。

pywebview が使えない環境 (未インストール / WebView2ランタイム欠如など) では
既定のブラウザで開くフォールバックに自動で切り替わる。
"""
import socket
import threading
import time
import urllib.request

from app import app, APP_VERSION

APP_TITLE = f"カイロ骨盤分析 v{APP_VERSION}"
DEFAULT_WIDTH = 1280
DEFAULT_HEIGHT = 860


def _find_free_port(start=5000, end=5100):
    for port in range(start, end):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("空きポートが見つかりません")


def _serve(port):
    # debug=False, use_reloader=False は本番起動の必須条件
    app.run(host="127.0.0.1", port=port, debug=False, use_reloader=False, threaded=True)


def _wait_until_ready(url, timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            urllib.request.urlopen(url, timeout=0.5)
            return True
        except Exception:
            time.sleep(0.1)
    return False


def _browser_fallback(url, reason):
    print(f"[フォールバック] {reason}")
    print(f"ブラウザで開きます: {url}")
    import webbrowser
    webbrowser.open(url)
    # ウィンドウを持たないため、サーバーを生かしたまま待機する
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass


def main():
    port = _find_free_port()
    url = f"http://127.0.0.1:{port}/"

    threading.Thread(target=_serve, args=(port,), daemon=True).start()
    _wait_until_ready(url)

    try:
        import webview
    except ImportError:
        _browser_fallback(url, "pywebview が見つかりません。")
        return

    try:
        webview.create_window(APP_TITLE, url, width=DEFAULT_WIDTH, height=DEFAULT_HEIGHT)
        webview.start()
    except Exception as e:
        # 例: Windows で WebView2 ランタイムが無い場合など
        _browser_fallback(url, f"ネイティブウィンドウを起動できませんでした ({e})")


if __name__ == "__main__":
    main()
