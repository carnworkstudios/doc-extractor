"""
Download the pre-trained YOLOv8n-DocLayNet model from HuggingFace
and export it to ONNX format for browser-side inference.

Requirements:
    pip install ultralytics huggingface_hub

Usage:
    python scripts/download-model.py

Output:
    src/public/models/yolov8n-doclaynet.onnx  (~12MB)

Source model: https://huggingface.co/hantian/yolo-doclaynet
- YOLOv8 nano variant (smallest, fastest)
- Trained on DocLayNet (11 classes, 640x640 input)
- Classes: text, picture, caption, section-heading, footnote,
           formula, table, list-item, page-header, page-footer, title
"""

import os
from pathlib import Path
from huggingface_hub import hf_hub_download
from ultralytics import YOLO

REPO_ID = "hantian/yolo-doclaynet"
MODEL_FILE = "yolov8n-doclaynet.pt"
# Vite publicDir is pdf-processor/public/ (project root moved out of src/).
OUTPUT_DIR = Path(__file__).parent.parent / "public" / "models"

def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # Step 1: Download .pt from HuggingFace
    print(f"Downloading {MODEL_FILE} from {REPO_ID}...")
    pt_path = hf_hub_download(repo_id=REPO_ID, filename=MODEL_FILE)
    print(f"  Downloaded to: {pt_path}")

    # Step 2: Export to ONNX
    print("Exporting to ONNX (640x640, simplified)...")
    model = YOLO(pt_path)
    onnx_path = model.export(format="onnx", imgsz=640, simplify=True)
    print(f"  Exported to: {onnx_path}")

    # Step 3: Copy to project
    dest = OUTPUT_DIR / "yolov8n-doclaynet.onnx"
    os.replace(onnx_path, str(dest))
    size_mb = dest.stat().st_size / (1024 * 1024)
    print(f"  Moved to: {dest}")
    print(f"  Size: {size_mb:.1f} MB")
    print("\nDone! Model is ready for browser-side inference.")

if __name__ == "__main__":
    main()
