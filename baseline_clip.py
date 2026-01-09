import torch
import torch.nn as nn
from torch.utils.data import DataLoader, Dataset
import pandas as pd
from PIL import Image
from transformers import CLIPProcessor, CLIPModel
import os
from tqdm import tqdm
import re

# Config
# Using ViT-Large to be fair against DINOv2-Large
MODEL_ID = "openai/clip-vit-large-patch14" 
CSV_FILE = "waste-wizard.csv"
TRAIN_IMAGES_DIR = "training_data/"
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
BATCH_SIZE = 32
VAL_HOLDOUT = 10

def sanitize_filename(name):
    return re.sub(r'[<>:"/\\|?*]', '_', name).strip()

class WasteDataset(Dataset):
    def __init__(self, data_list, processor):
        self.data_list = data_list
        self.processor = processor

    def __len__(self):
        return len(self.data_list)

    def __getitem__(self, idx):
        image_path, label = self.data_list[idx]
        try:
            image = Image.open(image_path).convert("RGB")
        except Exception as e:
            image = Image.new('RGB', (224, 224), color='black')
        
        # CLIP Processor handles images
        return {
            "image": image,
            "label": label,
            "path": image_path
        }

def main():
    print(f"--- CLIP Baseline Evaluation ({MODEL_ID}) ---")
    
    # 1. Dataset Setup (Exact match to V22 logic)
    df = pd.read_csv(CSV_FILE)
    items = df['Item'].tolist()
    # Build text descriptions closer to CLIP style
    # "A photo of {item}, a type of {category}."
    texts = []
    
    # Map for validation selection
    name_to_idx = {sanitize_filename(item.split('/')[0].strip()): idx for idx, item in enumerate(items)}
    
    for _, row in df.iterrows():
        item = row.get('Item', '').strip()
        cat = row.get('Category', '').strip()
        # Simple template for CLIP
        texts.append(f"A photo of {item}, which is {cat}.")
        
    print(f"Loaded {len(texts)} text classes.")

    # Scan Validation Images
    val_list = []
    folders = os.listdir(TRAIN_IMAGES_DIR)
    
    print("Scanning validation set...")
    for f in folders:
        if f in name_to_idx:
            idx = name_to_idx[f]
            folder_path = os.path.join(TRAIN_IMAGES_DIR, f)
            images = [os.path.join(folder_path, img) for img in os.listdir(folder_path) 
                      if img.lower().endswith(('.png', '.jpg', '.jpeg', '.webp'))]
            
            # Deterministic Split
            images.sort()
            if len(images) > VAL_HOLDOUT:
                val_subset = images[-VAL_HOLDOUT:]
                for img_path in val_subset:
                    val_list.append((img_path, idx))
                    
    print(f"Validation Samples: {len(val_list)}")

    # 2. Load Model
    print("Loading CLIP Model...")
    model = CLIPModel.from_pretrained(MODEL_ID).to(DEVICE)
    processor = CLIPProcessor.from_pretrained(MODEL_ID)
    model.eval()

    # 3. Encode Text (Offline)
    print("Encoding Text...")
    text_features_list = []
    with torch.no_grad():
        for i in range(0, len(texts), BATCH_SIZE):
            batch_texts = texts[i : i+BATCH_SIZE]
            inputs = processor(text=batch_texts, return_tensors="pt", padding=True, truncation=True).to(DEVICE)
            outputs = model.get_text_features(**inputs)
            # Normalize
            outputs = outputs / outputs.norm(p=2, dim=-1, keepdim=True)
            text_features_list.append(outputs)
            
    text_embeddings = torch.cat(text_features_list, dim=0) # (2205, 512/768)
    print(f"Text Embeddings: {text_embeddings.shape}")

    # 4. Evaluation Loop
    print("Running Inference...")
    all_ranks = []
    
    # Custom Collate to handle list of diverse images if needed, 
    # but CLIPProcessor works best on batches of PIL images or Tensors.
    # We'll batch manually or just process in loop carefully.
    
    loader = DataLoader(WasteDataset(val_list, None), batch_size=BATCH_SIZE, shuffle=False, num_workers=0, collate_fn=lambda x: x)
    
    with torch.no_grad():
        for batch_data in tqdm(loader):
            images = [b["image"] for b in batch_data]
            labels = torch.tensor([b["label"] for b in batch_data]).to(DEVICE)
            
            inputs = processor(images=images, return_tensors="pt", padding=True).to(DEVICE)
            image_features = model.get_image_features(**inputs)
            image_features = image_features / image_features.norm(p=2, dim=-1, keepdim=True)
            
            # Cosine Similarity
            # (B, D) @ (N, D).T = (B, N)
            scores = image_features @ text_embeddings.T
            
            # Sorting
            sorted_scores, sorted_indices = torch.sort(scores, descending=True, dim=1)
            
            for i in range(len(labels)):
                gt = labels[i].item()
                rank = (sorted_indices[i] == gt).nonzero(as_tuple=True)[0].item()
                all_ranks.append(rank + 1)
                
    # 5. Compute Metrics
    print("\n--- CLIP Baseline Results ---")
    total = len(all_ranks)
    metrics = {}
    
    print(f"{'K':<5} | {'Recall':<10} | {'Count':<10}")
    print("-" * 30)
    
    for k in range(1, 51):
        hits = sum(1 for r in all_ranks if r <= k)
        recall = (hits / total) * 100
        metrics[k] = recall
        
        if k in [1, 5, 10, 20, 50]:
            print(f"{k:<5} | {recall:.2f}%     | {hits}/{total}")
            
    # Save
    pd.DataFrame([{"k": k, "recall": v} for k, v in metrics.items()]).to_csv("clip_baseline_recall.csv", index=False)

if __name__ == "__main__":
    main()
