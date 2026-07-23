"""骨盤レントゲンの模擬画像を生成するスクリプト（テスト用）"""
import numpy as np
import cv2

def generate_sample_pelvis_xray(output_path="static/sample/sample_pelvis.png"):
    h, w = 600, 500
    img = np.zeros((h, w), dtype=np.uint8)
    img[:] = 20

    # Pelvis outline (simplified)
    cv2.ellipse(img, (w // 2, int(h * 0.45)), (180, 120), 0, 0, 360, 80, -1)
    cv2.ellipse(img, (w // 2, int(h * 0.45)), (160, 100), 0, 0, 360, 40, -1)

    # Left iliac wing
    pts_l = np.array([
        [w // 2 - 30, int(h * 0.3)],
        [w // 2 - 150, int(h * 0.25)],
        [w // 2 - 170, int(h * 0.35)],
        [w // 2 - 140, int(h * 0.5)],
        [w // 2 - 60, int(h * 0.55)],
    ], np.int32)
    cv2.fillPoly(img, [pts_l], 120)
    cv2.polylines(img, [pts_l], True, 160, 2)

    # Right iliac wing (slightly higher to simulate tilt)
    tilt_offset = 8
    pts_r = np.array([
        [w // 2 + 30, int(h * 0.3) - tilt_offset],
        [w // 2 + 150, int(h * 0.25) - tilt_offset],
        [w // 2 + 170, int(h * 0.35) - tilt_offset],
        [w // 2 + 140, int(h * 0.5) - tilt_offset],
        [w // 2 + 60, int(h * 0.55) - tilt_offset],
    ], np.int32)
    cv2.fillPoly(img, [pts_r], 120)
    cv2.polylines(img, [pts_r], True, 160, 2)

    # Sacrum
    sacrum_pts = np.array([
        [w // 2 - 25, int(h * 0.4)],
        [w // 2 + 25, int(h * 0.4)],
        [w // 2 + 15, int(h * 0.55)],
        [w // 2 - 15, int(h * 0.55)],
    ], np.int32)
    cv2.fillPoly(img, [sacrum_pts], 100)

    # Femoral heads
    cv2.circle(img, (w // 2 - 80, int(h * 0.58)), 30, 130, -1)
    cv2.circle(img, (w // 2 + 80, int(h * 0.58) - tilt_offset), 30, 130, -1)

    # Femoral shafts
    cv2.line(img, (w // 2 - 80, int(h * 0.62)), (w // 2 - 90, h), 100, 18)
    cv2.line(img, (w // 2 + 80, int(h * 0.62) - tilt_offset), (w // 2 + 70, h), 100, 18)

    # Obturator foramina
    cv2.ellipse(img, (w // 2 - 65, int(h * 0.5)), (25, 35), -10, 0, 360, 30, -1)
    cv2.ellipse(img, (w // 2 + 65, int(h * 0.5) - tilt_offset), (25, 35), 10, 0, 360, 30, -1)

    # Spine (lumbar)
    for i in range(5):
        y_center = int(h * 0.08) + i * 45
        cv2.rectangle(img, (w // 2 - 18 + (i % 2) * 3, y_center),
                      (w // 2 + 18 + (i % 2) * 3, y_center + 35), 110, -1)
        cv2.rectangle(img, (w // 2 - 18 + (i % 2) * 3, y_center),
                      (w // 2 + 18 + (i % 2) * 3, y_center + 35), 150, 1)

    # Add noise for realism
    noise = np.random.normal(0, 8, (h, w)).astype(np.int16)
    img = np.clip(img.astype(np.int16) + noise, 0, 255).astype(np.uint8)

    # Slight blur
    img = cv2.GaussianBlur(img, (3, 3), 0)

    # Convert to 3-channel
    img_color = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)

    cv2.imwrite(output_path, img_color)
    print(f"Sample pelvis X-ray saved to {output_path}")
    return output_path


if __name__ == "__main__":
    generate_sample_pelvis_xray()
