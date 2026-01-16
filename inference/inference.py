"""
QK Fusion V2.4 - Clean Inference Script
Run this to classify an image using the QK Fusion model.
Usage: python inference.py --image path/to/image.jpg
"""

import torch
import torch.nn.functional as F
from inference.model import CrossAttentionMatcher
from transformers import AutoProcessor, AutoTokenizer
import pandas as pd
from PIL import Image
import os
import argparse
import base64
import io
import requests
import json

# --- Configuration ---
# Get the base directory (project root)
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_CHECKPOINT = os.path.join(BASE_DIR, "v2_frozen_ep25.pth")
CSV_FILE = os.path.join(BASE_DIR, "waste-wizard.csv")
MODEL_ID_TXT = "BAAI/bge-large-en-v1.5"
MODEL_ID_IMG = "facebook/dinov2-large"
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
LLM_API_URL = "https://waste-classifier.yousifaldakoki.workers.dev/"

def load_resources():
    print(f"Loading model on {DEVICE}...")
    print(f"Looking for checkpoint at: {MODEL_CHECKPOINT}")
    print(f"Looking for CSV at: {CSV_FILE}")
    
    # 1. Load Model Architecture
    model = CrossAttentionMatcher(MODEL_ID_TXT, MODEL_ID_IMG)
    
    # 2. Load Weights
    if not os.path.exists(MODEL_CHECKPOINT):
        print(f"ERROR: Checkpoint {MODEL_CHECKPOINT} not found.")
        return None, None, None, None
    model.load_state_dict(torch.load(MODEL_CHECKPOINT, map_location=DEVICE))
    model.to(DEVICE)
    model.eval()
    print("Model loaded successfully.")

    # 3. Load Processors
    processor = AutoProcessor.from_pretrained(MODEL_ID_IMG)
    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID_TXT)
    
    # 4. Load Database
    if not os.path.exists(CSV_FILE):
        print(f"ERROR: Database {CSV_FILE} not found.")
        return None, None, None, None
    df = pd.read_csv(CSV_FILE)
    print(f"CSV loaded successfully with {len(df)} rows.")
    
    return model, processor, tokenizer, df

def encode_database(model, tokenizer, df):
    print("Pre-encoding text database (2205 items)...")
    def build_string(row):
        return f"{row.get('Item', '').strip()}. {row.get('Instruction_1','')}. Category: {row.get('Category','')}"
    rows_text = [build_string(row) for _, row in df.iterrows()]
    
    all_keys = []
    with torch.no_grad():
        for i in range(0, len(rows_text), 128):
            batch = rows_text[i:i+128]
            inputs = tokenizer(batch, padding=True, truncation=True, return_tensors="pt").to(DEVICE)
            all_keys.append(model.encode_text(inputs.input_ids, inputs.attention_mask))
    return torch.cat(all_keys, dim=0).detach()

def classify(image_path, model, processor, cached_k, df):
    if not os.path.exists(image_path):
        print(f"ERROR: Image {image_path} not found.")
        return None

    image = Image.open(image_path).convert("RGB")
    pixel_values = processor(images=image, return_tensors="pt").pixel_values.to(DEVICE)

    with torch.no_grad():
        q_vectors = model.forward_image(pixel_values)
        scores = model.score(q_vectors, cached_k)

    # Get top 5
    top5_scores, top5_indices = scores[0].topk(5)
    items = df['Item'].tolist()
    results = []
    for i, (idx, score) in enumerate(zip(top5_indices.cpu().numpy(), top5_scores.cpu().numpy())):
        item_name = items[idx]
        category = df.iloc[idx]['Category']
        instruction = df.iloc[idx].get('Instruction_1', '')
        results.append({
            "item": item_name,
            "category": category,
            "confidence": float(score),
            "instruction": instruction
        })
    
    # Convert image to base64
    buffered = io.BytesIO()
    image.save(buffered, format="JPEG")
    img_base64 = base64.b64encode(buffered.getvalue()).decode('utf-8')
    image_data_url = f"data:image/jpeg;base64,{img_base64}"
    
    # Build prompt with top 5 results
    top5_text = "\n".join([
        f"{i+1}. {r['item']} (Category: {r['category']}, Confidence: {r['confidence']:.3f})\n   Instruction: {r['instruction']}"
        for i, r in enumerate(results)
    ])
    
    prompt = f"""Analyze this waste item image and the top 5 model predictions below. 
    Determine which prediction is most accurate based on the visual content.
    
    Top 5 Predictions:
    {top5_text}
    
    Return a JSON response with:
    - "item": the correct item name
    - "category": the disposal category
    - "instruction": the disposal instruction
    - "reasoning": brief explanation of your choice
    
    Respond ONLY with valid JSON, no additional text."""
    
    # Call LLM API
    try:
        print("Calling LLM API for final classification...")
        response = requests.post(
            LLM_API_URL,
            json={
                "imageDataUrl": image_data_url,
                "customPrompt": prompt
            },
            timeout=30
        )
        response.raise_for_status()
        
        # Parse LLM response
        llm_result = response.json()
        print("LLM Classification Result:")
        print(json.dumps(llm_result, indent=2))
        return llm_result
        
    except Exception as e:
        print(f"Error calling LLM API: {e}")
        print("Falling back to top prediction from model.")
        return results[0]
