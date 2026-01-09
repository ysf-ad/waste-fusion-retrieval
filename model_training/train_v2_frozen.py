import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import Dataset, DataLoader
from torchvision import transforms
from transformers import AutoProcessor
from inference.model import CrossAttentionMatcher
import pandas as pd
import os
import re
from PIL import Image
from tqdm import tqdm

# Environment Setup
os.environ["TF_ENABLE_ONEDNN_OPTS"] = "0"
torch.backends.cudnn.benchmark = True

# Configuration
CSV_FILE = "waste-wizard.csv"
TRAIN_IMAGES_DIR = "training_data/"
MODEL_ID_TXT = "BAAI/bge-large-en-v1.5"
MODEL_ID_IMG = "facebook/dinov2-large"

# Hyperparameters - FROZEN ENCODERS + FUSION HEAD ONLY
BATCH_SIZE = 64
EPOCHS = 50
LR = 2e-4 # Single LR since we're not fine-tuning backbone
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
NUM_WORKERS = 4
VAL_HOLDOUT = 10
LABEL_SMOOTHING = 0.1

def sanitize_filename(name):
    return re.sub(r'[<>:"/\\|?*]', '_', name).strip()

class AugmentingWasteDataset(Dataset):
    def __init__(self, data_list, processor, is_train=True):
        self.data_list = data_list
        self.processor = processor
        self.is_train = is_train
        
        if is_train:
            self.aug = transforms.Compose([
                transforms.RandomResizedCrop(224, scale=(0.6, 1.0)),
                transforms.RandomHorizontalFlip(),
                transforms.ColorJitter(brightness=0.4, contrast=0.4, saturation=0.3, hue=0.1),
                transforms.RandomGrayscale(p=0.1),
                transforms.GaussianBlur(3, sigma=(0.1, 2.0)),
            ])
        else:
            self.aug = None

    def __len__(self): return len(self.data_list)

    def __getitem__(self, idx):
        item = self.data_list[idx]
        image_path = item['image_path']
        label = item['label_idx']
        
        try:
            image = Image.open(image_path).convert("RGB")
            if self.aug:
                image = self.aug(image)
        except Exception:
            image = Image.new('RGB', (224, 224), color='black')
            
        pixel_values = self.processor(images=image, return_tensors="pt").pixel_values.squeeze(0)
        return {"pixel_values": pixel_values, "labels": torch.tensor(label, dtype=torch.long)}

def prepare_datasets():
    print("--- Preparing Datasets ---")
    df = pd.read_csv(CSV_FILE)
    items = df['Item'].tolist()
    name_to_idx = {sanitize_filename(item.split('/')[0].strip()): idx for idx, item in enumerate(items)}
    
    train_list = []
    val_list = []
    
    for folder_name in sorted(os.listdir(TRAIN_IMAGES_DIR)):
        folder_path = os.path.join(TRAIN_IMAGES_DIR, folder_name)
        if not os.path.isdir(folder_path) or folder_name not in name_to_idx:
            continue
            
        label_idx = name_to_idx[folder_name]
        images = sorted([os.path.join(folder_path, f) for f in os.listdir(folder_path) if f.lower().endswith(('.jpg', '.jpeg', '.png'))])
        
        if len(images) <= VAL_HOLDOUT:
            if len(images) > 1:
                train_list.extend([{'image_path': p, 'label_idx': label_idx} for p in images[:-1]])
                val_list.append({'image_path': images[-1], 'label_idx': label_idx})
            else:
                train_list.extend([{'image_path': p, 'label_idx': label_idx} for p in images])
        else:
            train_list.extend([{'image_path': p, 'label_idx': label_idx} for p in images[:-VAL_HOLDOUT]])
            val_list.extend([{'image_path': p, 'label_idx': label_idx} for p in images[-VAL_HOLDOUT:]])
            
    print(f"Train: {len(train_list)} | Val: {len(val_list)}")
    return train_list, val_list

def train():
    train_list, val_list = prepare_datasets()
    processor = AutoProcessor.from_pretrained(MODEL_ID_IMG)
    
    train_loader = DataLoader(
        AugmentingWasteDataset(train_list, processor), 
        batch_size=BATCH_SIZE, 
        shuffle=True, 
        num_workers=NUM_WORKERS, 
        pin_memory=True
    )
    val_loader = DataLoader(
        AugmentingWasteDataset(val_list, processor, is_train=False), 
        batch_size=BATCH_SIZE, 
        shuffle=False, 
        num_workers=NUM_WORKERS, 
        pin_memory=True
    )
    
    # Create model with FROZEN encoders
    model = CrossAttentionMatcher(MODEL_ID_TXT, MODEL_ID_IMG)
    # DO NOT call set_trainable_backbone - keep encoders frozen
    model.to(DEVICE)
    
    # Verify encoders are frozen
    for name, param in model.named_parameters():
        if 'text_encoder' in name or 'image_encoder' in name:
            assert not param.requires_grad, f"Encoder {name} should be frozen!"
    
    print("Encoders confirmed FROZEN. Only fusion head is trainable.")
    
    # Identity Init for Text Projection
    with torch.no_grad():
        nn.init.eye_(model.W_t.weight)
        nn.init.zeros_(model.W_t.bias)
    
    # Only optimize fusion head parameters
    trainable_params = [p for p in model.parameters() if p.requires_grad]
    print(f"Trainable parameters: {sum(p.numel() for p in trainable_params):,}")
    
    optimizer = optim.AdamW(trainable_params, lr=LR, weight_decay=1e-2)
    
    # Learning Rate Scheduler
    scheduler = optim.lr_scheduler.OneCycleLR(
        optimizer,
        max_lr=LR,
        steps_per_epoch=len(train_loader),
        epochs=EPOCHS,
        pct_start=0.1
    )
    
    # Text Database Preparation
    df = pd.read_csv(CSV_FILE)
    def build_string(row):
        return f"{row.get('Item', '').strip()}. {row.get('Instruction_1','')}. Category: {row.get('Category','')}"
    rows_text = [build_string(row) for _, row in df.iterrows()]
    
    from transformers import AutoTokenizer
    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID_TXT)
    
    scaler = torch.amp.GradScaler('cuda')
    print(f"\nStarting 50-Epoch Training (Frozen Encoders + Fusion Head Only)...")
    
    best_acc = 0
    for epoch in range(EPOCHS):
        # Regenerate Keys each epoch (fusion head is learning)
        model.eval()
        all_keys = []
        with torch.no_grad():
            for i in range(0, len(rows_text), 128):
                batch = rows_text[i:i+128]
                inputs = tokenizer(batch, padding=True, truncation=True, return_tensors="pt").to(DEVICE)
                all_keys.append(model.encode_text(inputs.input_ids, inputs.attention_mask))
        cached_k = torch.cat(all_keys, dim=0).detach()
        
        model.train()
        pbar = tqdm(train_loader, desc=f"Epoch {epoch+1}/{EPOCHS}")
        epoch_loss = 0
        
        for batch in pbar:
            pixel_values = batch["pixel_values"].to(DEVICE, non_blocking=True)
            labels = batch["labels"].to(DEVICE, non_blocking=True)
            
            optimizer.zero_grad()
            with torch.amp.autocast('cuda'):
                q_vectors = model.forward_image(pixel_values)
                scores = model.score(q_vectors, cached_k)
                loss = nn.functional.cross_entropy(scores, labels, label_smoothing=LABEL_SMOOTHING)
            
            scaler.scale(loss).backward()
            scaler.step(optimizer)
            scaler.update()
            scheduler.step()
            
            epoch_loss += loss.item()
            pbar.set_postfix({"loss": f"{loss.item():.4f}", "lr": f"{scheduler.get_last_lr()[0]:.1e}"})
            
        # Validation
        model.eval()
        correct = 0
        total = 0
        with torch.no_grad():
            for batch in val_loader:
                pixel_values = batch["pixel_values"].to(DEVICE)
                labels = batch["labels"].to(DEVICE)
                q_vectors = model.forward_image(pixel_values)
                scores = model.score(q_vectors, cached_k)
                correct += (scores.argmax(dim=1) == labels).sum().item()
                total += labels.size(0)
        
        val_acc = 100 * correct / total
        print(f"Epoch {epoch+1} Val Acc: {val_acc:.2f}% | Avg Loss: {epoch_loss/len(train_loader):.4f}")
        
        # Save on Epoch 25 and 50
        if epoch + 1 == 25:
            torch.save(model.state_dict(), "v2_frozen_ep25.pth")
            print("Saved Checkpoint: Epoch 25")
        
        if val_acc > best_acc:
            best_acc = val_acc

    torch.save(model.state_dict(), "v2_frozen_final.pth")
    print(f"Training Complete! Best Val Acc: {best_acc:.2f}%")

if __name__ == "__main__":
    train()
