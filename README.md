# Waste Fusion Retrieval (QK Fusion V2.4)

A semantic retrieval-based waste classification system using **DINOv2** for images and **BGE** for text, fused with a cross-attention head.

## Kiosk update sync check

Sync marker: `kiosk-ui-sync-20261107` (available on `main` and `countdown-fix`).

The updated kiosk UI has a prominent item name, plain disposal instructions,
a subtle optional Full response box, and the preserved 180-degree display rotation.
After pulling, restart the kiosk service to load the updated UI. This marker is
for checking that the latest repository changes reached the device; it does not
reset local files or resolve pull conflicts.

## 🚀 Performance
- **Recall@1**: 64.6%
- **Recall@50**: 95.5%
- Based on 2,205 waste categories from the "Waste Wizard" database.

## 📦 Structure
- `model.py`: The QK Fusion architecture.
- `inference.py`: Simple CLI for classifying images.
- `demo_ui.py`: Gradio-based web interface.
- `train_v2_frozen.py`: Training script for the fusion head.
- `waste-wizard.csv`: The knowledge base (Item, Category, Instructions).

## 🛠️ Usage

### Installation
```bash
pip install torch torchvision transformers pandas pillow tqdm gradio
```

### Classification (CLI)
```bash
python inference.py --image path/to/waste.jpg
```

### Web UI
```bash
python demo_ui.py
```

## ⚠️ Model Weights
The model weights (`v2_frozen_ep25.pth`) are approximately **2.5GB** and are excluded from this repository due to size limits. You must download them separately and place them in the root directory to run inference.
