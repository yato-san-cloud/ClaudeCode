"""デスクトップアプリとしての起動エントリポイント。

Flask サーバーをバックグラウンドスレッドで立ち上げ、pywebview の
ネイティブウィンドウで開く。ブラウザもターミナルも不要、
ダブルクリックで起動できる "アプリ" として振る舞う。
"""
import socket
import threading
import time
import urllib.request

from app import app

APP_TITLE = "カイロ紹介状アプリ"
DEFAULT_WIDTH = 1180
DEFAULT_HEIGHT = 820


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


def main():
    port = _find_free_port()
    url = f"http://127.0.0.1:{port}/"

    threading.Thread(target=_serve, args=(port,), daemon=True).start()
    _wait_until_ready(url)

    try:
        import webview
    except ImportError:
        print(f"[フォールバック] pywebview 未インストール。ブラウザで開いてください: {url}")
        import webbrowser
        webbrowser.open(url)
        # サーバーを生かしたままにする
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
        return

    webview.create_window(APP_TITLE, url, width=DEFAULT_WIDTH, height=DEFAULT_HEIGHT)
    webview.start()


if __name__ == "__main__":
    main()
