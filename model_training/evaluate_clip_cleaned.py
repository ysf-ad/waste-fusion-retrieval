"""Re-evaluate CLIP baseline on cleaned validation set"""
import torch
import pandas as pd
from transformers import CLIPProcessor, CLIPModel
from PIL import Image
from tqdm import tqdm
import os
import re
import random

random.seed(42)

# Config
CSV_FILE = "waste-wizard.csv"
TRAIN_IMAGES_DIR = "training_data/"
MODEL_ID = "openai/clip-vit-large-patch14"
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
VAL_HOLDOUT = 10

def sanitize_filename(name):
    return re.sub(r'[<>:"/\\|?*]', '_', name).strip()

# Load CLIP
print("Loading CLIP model...")
model = CLIPModel.from_pretrained(MODEL_ID).to(DEVICE)
processor = CLIPProcessor.from_pretrained(MODEL_ID)

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

# Build text prompts
text_prompts = [f"a photo of {item.split('/')[0].strip()}" for item in items]

# Pre-encode text
print("Encoding text database...")
text_inputs = processor(text=text_prompts, padding=True, return_tensors="pt").to(DEVICE)
with torch.no_grad():
    text_features = model.get_text_features(**text_inputs)
    text_features = text_features / text_features.norm(p=2, dim=-1, keepdim=True)

# Evaluate
print("Evaluating...")
recall_at_k = {k: 0 for k in range(1, 51)}

for item in tqdm(val_list):
    try:
        image = Image.open(item['image_path']).convert("RGB")
    except:
        continue
    
    image_inputs = processor(images=image, return_tensors="pt").to(DEVICE)
    
    with torch.no_grad():
        image_features = model.get_image_features(**image_inputs)
        image_features = image_features / image_features.norm(p=2, dim=-1, keepdim=True)
        similarity = (image_features @ text_features.T)[0]
    
    _, top50_indices = similarity.topk(50)
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
results.to_csv('clip_recall_cleaned.csv', index=False)

print("\n=== CLIP (Cleaned Val Set) ===")
for k in [1, 5, 30, 50]:
    print(f"Recall@{k}: {results[results['k']==k]['recall'].values[0]:.2f}%")
