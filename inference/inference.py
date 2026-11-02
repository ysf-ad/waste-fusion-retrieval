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

# Groq API Configuration
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"
if not GROQ_API_KEY:
    print("WARNING: GROQ_API_KEY not found in environment variables. Please set it in .env file.")

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

    # Get top 20
    top20_scores, top20_indices = scores[0].topk(20)
    items = df['Item'].tolist()
    results = []
    for i, (idx, score) in enumerate(zip(top20_indices.cpu().numpy(), top20_scores.cpu().numpy())):
        item_name = items[idx]
        category = df.iloc[idx]['Category']
        instruction = df.iloc[idx].get('Instruction_1', '')
        results.append({
            "item": item_name,
            "category": category,
            "confidence": float(score),
            "instruction": instruction
        })
    
    # Build prompt with top 20 results
    top20_text = "\n".join([
        f"{i+1}. {r['item']} (Visual Match Score: {r['confidence']:.3f}, Category: {r['category']})\n   Disposal Context: {r['instruction']}"
        for i, r in enumerate(results)
    ])
    
    custom_prompt = f"""You are the Waste Wizard AI, a helpful and expert assistant for waste classification. 
Your task is to identify the correct item from a list of 20 visual matches and provide personalized disposal advice.

The list includes visual match scores and up to 3 specific context columns from our database for each item. 

GUIDELINES:
1. SELECT the best match based on both visual score and common sense.
2. PERSONALIZE the advice: Synthesize all the provided context into a friendly, clear, and personalized message for the user.
3. Be specific: If there are conditional instructions (e.g., "if empty", "remove lid"), make sure to mention them conversationally.

Top 20 Visual Matches:
{top20_text}

Return a JSON object:
{{
  "selected_item": "The exact name of the item from the list",
  "reasoning": "Briefly explain why this is the best match.",
  "disposal_instruction": "A personalized, comprehensive synthesis of all provided disposal context entries."
}}

Respond ONLY with valid JSON, no additional text."""
    
    # Convert image to base64 data URL
    buffered = io.BytesIO()
    image.save(buffered, format="JPEG")
    buffered.seek(0)
    base64_image = base64.b64encode(buffered.read()).decode('utf-8')
    image_data_url = f"data:image/jpeg;base64,{base64_image}"
    
    # Call Groq API using direct HTTP POST
    try:
        print("Calling Groq LLM API for final classification...")
        
        if not GROQ_API_KEY:
            print("Groq API key not configured. Falling back to top prediction from model.")
            return results
        
        headers = {
            "Authorization": f"Bearer {GROQ_API_KEY}",
            "Content-Type": "application/json"
        }
        
        payload = {
            "model": "meta-llama/llama-4-scout-17b-16e-instruct",
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": custom_prompt
                        },
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": image_data_url
                            }
                        }
                    ]
                }
            ],
            "temperature": 1,
            "max_completion_tokens": 1024,
            "top_p": 1,
            "stream": False,
            "response_format": {"type": "json_object"},
            "stop": None
        }
        
        response = requests.post(GROQ_API_URL, headers=headers, json=payload, timeout=30)
        
        if response.status_code != 200:
            print(f"⚠ Groq API returned status {response.status_code}: {response.text}")
            print("✓ Falling back to top model prediction")
            print(f"Top prediction: {results[0]['item']} ({results[0]['category']})")
            return results
        
        response_data = response.json()
        response_text = response_data['choices'][0]['message']['content']
        print("Groq Classification Result:")
        print(response_text)
        
        # Try to parse as JSON
        try:
            llm_result = json_lib.loads(response_text)
            
            # Check if it's an error response
            if 'error' in llm_result or 'Error' in llm_result:
                print("⚠ Groq returned an error response:", llm_result)
                print("✓ Falling back to top model prediction")
                print(f"Top prediction: {results[0]['item']} ({results[0]['category']})")
                return results
            
            # Map Groq response to our format
            if 'selected_item' in llm_result:
                llm_result['item'] = llm_result.pop('selected_item')
            
            # Map disposal_instruction to instruction
            if 'disposal_instruction' in llm_result:
                llm_result['instruction'] = llm_result.pop('disposal_instruction')
            
            # Get category from results if not present
            if 'category' not in llm_result and 'item' in llm_result:
                # Try to find matching category from results
                for r in results:
                    if r['item'].lower() == llm_result['item'].lower():
                        llm_result['category'] = r['category']
                        if 'instruction' not in llm_result:
                            llm_result['instruction'] = r['instruction']
                        break
                if 'category' not in llm_result:
                    llm_result['category'] = results[0]['category']
            
            # Add instruction from database if not present
            if 'instruction' not in llm_result:
                llm_result['instruction'] = results[0]['instruction']
            
            # Validate that the result has required fields
            if 'item' in llm_result and 'category' in llm_result:
                print("✓ Groq API succeeded - using LLM result")
                # Return results array with LLM result as first item
                llm_result_array = [llm_result] + results[1:]
                return llm_result_array
            else:
                print("⚠ Groq response missing required fields:", llm_result)
                print("✓ Falling back to top model prediction")
                print(f"Top prediction: {results[0]['item']} ({results[0]['category']})")
                return results
                
        except json_lib.JSONDecodeError as json_err:
            print(f"⚠ Could not parse Groq response as JSON: {json_err}")
            print("✓ Falling back to top model prediction")
            print(f"Top prediction: {results[0]['item']} ({results[0]['category']})")
            return results
        
    except Exception as e:
        print(f"⚠ Error calling Groq API: {e}")
        print("✓ Falling back to top model prediction")
        print(f"Top prediction: {results[0]['item']} ({results[0]['category']})")
        return results

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