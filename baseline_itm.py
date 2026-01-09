import torch
import time
import pandas as pd
from PIL import Image
from transformers import BlipProcessor, BlipForImageTextRetrieval
import os

# Configuration
MODEL_ID = "Salesforce/blip-itm-base-coco"
CSV_FILE = "waste-wizard.csv"
TEST_DIR = "../test-images"
BATCH_SIZE = 64  # Tunable: 32, 64, 128
TOP_K = 5
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

def build_text_strings(df):
    """Build full text descriptions for each row."""
    texts = []
    for idx, row in df.iterrows():
        item = row.get('Item', '').strip()
        cats = row.get('Category', '').strip()
        instr = f"{row.get('Instruction_1','')} {row.get('Instruction_2','')} {row.get('Instruction_3','')}".strip()
        instr = " ".join(instr.split())
        texts.append(f"{item}. {instr} Category: {cats}.")
    return texts

def main():
    print("=== BASELINE: ITM Cross-Encoder (BLIP) ===")
    print(f"Device: {DEVICE}")
    print(f"Batch Size: {BATCH_SIZE}")
    
    # Load model
    print("\nLoading BLIP-ITM...")
    processor = BlipProcessor.from_pretrained(MODEL_ID)
    model = BlipForImageTextRetrieval.from_pretrained(MODEL_ID).to(DEVICE)
    model.eval()
    
    # Load database
    print("Loading CSV...")
    df = pd.read_csv(CSV_FILE)
    texts = build_text_strings(df)
    N = len(texts)
    print(f"Total rows: {N}")
    
    # Test images
    image_files = [f for f in os.listdir(TEST_DIR) if f.lower().endswith(('.png','.jpg','.jpeg'))]
    
    total_latency = 0
    count = 0
    
    for img_file in image_files[:3]:  # Test on first 3 images for speed
        print(f"\n{'='*50}")
        print(f"Processing: {img_file}")
        path = os.path.join(TEST_DIR, img_file)
        image = Image.open(path).convert("RGB")
        
        # Batch scoring
        t0 = time.time()
        scores = []
        
        num_batches = (N + BATCH_SIZE - 1) // BATCH_SIZE
        
        with torch.no_grad():
            for i in range(num_batches):
                batch_texts = texts[i*BATCH_SIZE : (i+1)*BATCH_SIZE]
                
                # Process batch
                inputs = processor(
                    images=[image]*len(batch_texts),
                    text=batch_texts,
                    return_tensors="pt",
                    padding=True,
                    truncation=True
                ).to(DEVICE)
                
                # Forward pass
                outputs = model(**inputs)
                itm_scores = torch.nn.functional.softmax(outputs.itm_score, dim=1)[:, 1]
                scores.extend(itm_scores.cpu().tolist())
                
                if i % 10 == 0:
                    print(f"  Batch {i+1}/{num_batches}...")
        
        latency = (time.time() - t0) * 1000
        total_latency += latency
        count += 1
        
        # Get top-K
        scores_tensor = torch.tensor(scores)
        top_k_scores, top_k_indices = torch.topk(scores_tensor, TOP_K)
        
        print(f"\nLatency: {latency:.1f}ms")
        print("-" * 40)
        for j in range(TOP_K):
            idx = top_k_indices[j].item()
            score = top_k_scores[j].item()
            print(f"  {j+1}. [{score:.4f}] {df.iloc[idx]['Item']} ({df.iloc[idx]['Category']})")
    
    print(f"\n{'='*50}")
    print(f"Average Latency: {total_latency/count:.1f}ms")
    print(f"Batches per image: {num_batches}")
    print(f"Throughput: {N}/{(total_latency/count/1000):.2f} = {N/(total_latency/count/1000):.0f} rows/sec")

if __name__ == "__main__":
    main()
