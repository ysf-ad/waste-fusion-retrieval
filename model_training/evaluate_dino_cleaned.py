"""Re-evaluate DINO Linear baseline on cleaned validation set"""
import torch
import torch.nn as nn
from transformers import AutoModel
from PIL import Image
from tqdm import tqdm
import pandas as pd
import os
import re
import random

random.seed(42)

# Config
CHECKPOINT = "dino_linear_baseline.pth"
CSV_FILE = "waste-wizard.csv"
TRAIN_IMAGES_DIR = "training_data/"
MODEL_ID = "facebook/dinov2-large"
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
VAL_HOLDOUT = 10

def sanitize_filename(name):
    return re.sub(r'[<>:"/\\|?*]', '_', name).strip()

# Load model
class DinoLinearClassifier(nn.Module):
    def __init__(self, num_classes=2205):
        super().__init__()
        self.dino = AutoModel.from_pretrained(MODEL_ID)
        for p in self.dino.parameters():
            p.requires_grad = False
        self.classifier = nn.Linear(1024, num_classes)
    
    def forward(self, pixel_values):
        with torch.no_grad():
            outputs = self.dino(pixel_values=pixel_values)
            cls_token = outputs.last_hidden_state[:, 0]
        return self.classifier(cls_token)

print("Loading DINO Linear model...")
model = DinoLinearClassifier()
model.load_state_dict(torch.load(CHECKPOINT, map_location=DEVICE))
model.to(DEVICE)
model.eval()

# Prepare validation set
df = pd.read_csv(CSV_FILE)
items = df['Item'].tolist()
name_to_idx = {sanitize_filename(item.split('/')[0].strip()): idx for idx, item in enumerate(items)}

val_list = []
for folder_name in os.listdir(TRAIN_IMAGES_DIR):
    folder_path = os.path.join(TRAIN_IMAGES_DIR, folder_name)
    if not os.path.isdir(folder_path) or folder_name not in name_to_idx:
        continue
    label_idx = name_to_idx[folder_name]
    images = sorted([os.path.join(folder_path, f) for f in os.listdir(folder_path) if f.lower().endswith(('.jpg', '.jpeg', '.png'))])
    
    if len(images) <= VAL_HOLDOUT:
        if len(images) > 1:
            val_list.append({'image_path': images[-1], 'label_idx': label_idx})
    else:
        val_list.extend([{'image_path': p, 'label_idx': label_idx} for p in images[-VAL_HOLDOUT:]])

print(f"Total validation samples: {len(val_list)}")
if len(val_list) > 1000:
    val_list = random.sample(val_list, 1000)
print(f"Using {len(val_list)} samples for evaluation")

# Image processor
from transformers import AutoProcessor
processor = AutoProcessor.from_pretrained(MODEL_ID)

# Evaluate
print("Evaluating...")
recall_at_k = {k: 0 for k in range(1, 51)}

for item in tqdm(val_list):
    try:
        image = Image.open(item['image_path']).convert("RGB")
    except:
        continue
    
    pixel_values = processor(images=image, return_tensors="pt").pixel_values.to(DEVICE)
    
    with torch.no_grad():
        logits = model(pixel_values)
    
    _, top50_indices = logits[0].topk(50)
    top50 = top50_indices.cpu().numpy()
    true_label = item['label_idx']
    
    for k in range(1, 51):
        if true_label in top50[:k]:
            recall_at_k[k] += 1

# Save results
total = len(val_list)
results = pd.DataFrame({
    'k': list(range(1, 51)),
    'recall': [100 * recall_at_k[k] / total for k in range(1, 51)]
})
results.to_csv('dino_recall_cleaned.csv', index=False)

print("\n=== DINO Linear (Cleaned Val Set) ===")
for k in [1, 5, 30, 50]:
    print(f"Recall@{k}: {results[results['k']==k]['recall'].values[0]:.2f}%")
