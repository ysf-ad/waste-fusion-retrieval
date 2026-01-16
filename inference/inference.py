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
import json as json_lib
from dotenv import load_dotenv
from transformers import MarianMTModel, MarianTokenizer

# Load environment variables from .env file
load_dotenv()

# Global translation model variables
translation_model = None
translation_tokenizer = None

# --- Configuration ---
# Get the base directory (project root)
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_CHECKPOINT = os.path.join(BASE_DIR, "v2_frozen_ep25.pth")
CSV_FILE = os.path.join(BASE_DIR, "waste-wizard.csv")
MODEL_ID_TXT = "BAAI/bge-large-en-v1.5"
MODEL_ID_IMG = "facebook/dinov2-large"
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

# Grok API Configuration
XAI_API_KEY = os.getenv("XAI_API_KEY")
if not XAI_API_KEY:
    print("WARNING: XAI_API_KEY not found in environment variables. Please set it in .env file.")

def load_resources():
    global translation_model, translation_tokenizer
    
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
    
    # 5. Load Translation Model (MarianMT)
    print("Loading translation model (Helsinki-NLP/opus-mt-en-fr)...")
    try:
        translation_model_name = "Helsinki-NLP/opus-mt-en-fr"
        translation_tokenizer = MarianTokenizer.from_pretrained(translation_model_name)
        translation_model = MarianMTModel.from_pretrained(translation_model_name)
        translation_model.to(DEVICE)
        translation_model.eval()
        print("Translation model loaded successfully.")
    except Exception as e:
        print(f"WARNING: Could not load translation model: {e}")
        print("Translation will be disabled.")
    
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
    
    # Save image to JPEG bytes
    buffered = io.BytesIO()
    image.save(buffered, format="JPEG")
    buffered.seek(0)
    
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
    
    # Call Grok LLM API using official xAI SDK
    try:
        print("Calling Grok LLM API for final classification...")
        
        if not XAI_API_KEY:
            print("xAI API key not configured. Falling back to top prediction from model.")
            return results[0]
        
        # Encode image to base64
        buffered.seek(0)
        base64_image = base64.b64encode(buffered.read()).decode('utf-8')
        
        # Initialize xAI client
        client = Client(
            api_key=XAI_API_KEY,
            timeout=3600
        )
        
        # Create chat with image and prompt
        chat = client.chat.create(model="llama-3.3-70b-versatile")
        chat.append(system("You are an AI assistant specialized in waste classification. Analyze images and return responses as valid JSON only."))
        
        # Create user message with image and text
        user_message = f"<image>data:image/jpeg;base64,{base64_image}</image>\n\n{prompt}"
        chat.append(user(user_message))
        
        # Get response
        response = chat.sample()
        response_text = response.content
        print("Grok Classification Result:")
        print(response_text)
        
        # Check if response looks like an error
        if 'error' in response_text.lower() or 'fail' in response_text.lower():
            print("⚠ Grok returned an error message")
            print("✓ Falling back to top model prediction")
            print(f"Top prediction: {results[0]['item']} ({results[0]['category']})")
            return results[0]
        
        # Try to parse as JSON
        try:
            llm_result = json_lib.loads(response_text)
            
            # Check if it's an error response (common error formats)
            if 'error' in llm_result or 'Error' in llm_result or 'message' in llm_result:
                print("⚠ Grok returned an error response:", llm_result)
                print("✓ Falling back to top model prediction")
                print(f"Top prediction: {results[0]['item']} ({results[0]['category']})")
                return results[0]
            
            # Validate that the result has required fields
            if 'item' in llm_result and 'category' in llm_result:
                print("✓ Grok API succeeded - using LLM result")
                return llm_result
            else:
                print("⚠ Grok response missing required fields:", llm_result)
                print("✓ Falling back to top model prediction")
                print(f"Top prediction: {results[0]['item']} ({results[0]['category']})")
                return results[0]
                
        except json_lib.JSONDecodeError as json_err:
            print(f"⚠ Could not parse Grok response as JSON: {json_err}")
            print("✓ Falling back to top model prediction")
            print(f"Top prediction: {results[0]['item']} ({results[0]['category']})")
            return results[0]
        
    except Exception as e:
        print(f"⚠ Error calling Grok API: {e}")
        print("✓ Falling back to top model prediction")
        print(f"Top prediction: {results[0]['item']} ({results[0]['category']})")
        return results[0]
def translate_text_to_french(text):
    """
    Translate English text to French using local MarianMT model
    """
    global translation_model, translation_tokenizer
    
    if translation_model is None or translation_tokenizer is None:
        print("WARNING: Translation model not loaded. Returning original text.")
        return text
    
    try:
        print(f"Translating to French: {text[:50]}...")
        
        # Tokenize the input text
        inputs = translation_tokenizer(text, return_tensors="pt", padding=True, truncation=True, max_length=512)
        inputs = {k: v.to(DEVICE) for k, v in inputs.items()}
        
        # Generate translation
        with torch.no_grad():
            translated_tokens = translation_model.generate(**inputs)
        
        # Decode the translated text
        translated_text = translation_tokenizer.decode(translated_tokens[0], skip_special_tokens=True)
        
        print(f"Translation result: {translated_text[:50]}...")
        return translated_text
        
    except Exception as e:
        print(f"Translation error: {e}")
        return text  # Return original text on error