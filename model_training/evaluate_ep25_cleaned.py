"""Evaluate Epoch 25 checkpoint on cleaned validation set"""
import torch
import pandas as pd
from model import CrossAttentionMatcher
from transformers import AutoProcessor, AutoTokenizer
from PIL import Image
from tqdm import tqdm
import os
import re
import random

random.seed(42)  # For reproducibility

# Config
CHECKPOINT = "v2_frozen_ep25.pth"
CSV_FILE = "waste-wizard.csv"
TRAIN_IMAGES_DIR = "training_data/"
MODEL_ID_TXT = "BAAI/bge-large-en-v1.5"
MODEL_ID_IMG = "facebook/dinov2-large"
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
VAL_HOLDOUT = 10

def sanitize_filename(name):
    return re.sub(r'[<>:"/\\|?*]', '_', name).strip()

# Load model
print("Loading Epoch 25 checkpoint...")
model = CrossAttentionMatcher(MODEL_ID_TXT, MODEL_ID_IMG)
model.load_state_dict(torch.load(CHECKPOINT, map_location=DEVICE))
model.to(DEVICE)
model.eval()

# Prepare validation set (same logic as training)
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
# Randomly sample 1000 for faster evaluation
if len(val_list) > 1000:
    val_list = random.sample(val_list, 1000)
print(f"Using {len(val_list)} samples for evaluation")

# Encode text database
def build_string(row):
    return f"{row.get('Item', '').strip()}. {row.get('Instruction_1','')}. Category: {row.get('Category','')}"
rows_text = [build_string(row) for _, row in df.iterrows()]

tokenizer = AutoTokenizer.from_pretrained(MODEL_ID_TXT)
processor = AutoProcessor.from_pretrained(MODEL_ID_IMG)

all_keys = []
with torch.no_grad():
    for i in range(0, len(rows_text), 32):
        batch = rows_text[i:i+32]
        inputs = tokenizer(batch, padding=True, truncation=True, return_tensors="pt").to(DEVICE)
        all_keys.append(model.encode_text(inputs.input_ids, inputs.attention_mask))
cached_k = torch.cat(all_keys, dim=0).detach()

# Evaluate
print("Evaluating Recall@1-50...")
recall_at_k = {k: 0 for k in range(1, 51)}

for item in tqdm(val_list):
    try:
        image = Image.open(item['image_path']).convert("RGB")
    except:
        continue
        
    pixel_values = processor(images=image, return_tensors="pt").pixel_values.to(DEVICE)
    
    with torch.no_grad():
        q_vectors = model.forward_image(pixel_values)
        scores = model.score(q_vectors, cached_k)
    
    _, top50_indices = scores[0].topk(50)
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
results.to_csv('ep25_recall_cleaned.csv', index=False)

print("\n=== Epoch 25 Model (Cleaned Val Set) ===")
for k in [1, 10, 30, 50]:
    print(f"Recall@{k}: {results[results['k']==k]['recall'].values[0]:.2f}%")

print(f"\nResults saved to ep25_recall_cleaned.csv")
