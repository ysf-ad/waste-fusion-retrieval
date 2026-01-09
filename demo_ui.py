import gradio as gr
import torch
import pandas as pd
from PIL import Image
from transformers import AutoProcessor, AutoTokenizer
from model import CrossAttentionMatcher
import os
import re

# Configuration
MODEL_CHECKPOINT = "v2_frozen_ep25.pth"
CSV_FILE = "waste-wizard.csv"
MODEL_ID_TXT = "BAAI/bge-large-en-v1.5"
MODEL_ID_IMG = "facebook/dinov2-large"
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

def sanitize_filename(name):
    return re.sub(r'[<>:"/\\|?*]', '_', name).strip()

# Load model and database
print("Loading QK Fusion V2.3...")
model = CrossAttentionMatcher(MODEL_ID_TXT, MODEL_ID_IMG)
model.load_state_dict(torch.load(MODEL_CHECKPOINT, map_location=DEVICE))
model.to(DEVICE)
model.eval()

# Load waste database
df = pd.read_csv(CSV_FILE)
items = df['Item'].tolist()

# Build text descriptions
def build_string(row):
    item = row.get('Item', '').strip()
    cats = row.get('Category', '').strip()
    instr = f"{row.get('Instruction_1','')} {row.get('Instruction_2','')} {row.get('Instruction_3','')}".strip()
    instr = " ".join(instr.split())
    return f"{item}. {instr} Category: {cats}."

rows_text = [build_string(row) for _, row in df.iterrows()]

# Pre-encode text keys
print("Encoding waste database (2205 items)...")
tokenizer = AutoTokenizer.from_pretrained(MODEL_ID_TXT)
processor = AutoProcessor.from_pretrained(MODEL_ID_IMG)

all_keys = []
with torch.no_grad():
    for i in range(0, len(rows_text), 32):
        batch = rows_text[i:i+32]
        inputs = tokenizer(batch, padding=True, truncation=True, return_tensors="pt").to(DEVICE)
        all_keys.append(model.encode_text(inputs.input_ids, inputs.attention_mask))

cached_k = torch.cat(all_keys, dim=0).detach()
print(f"Ready! Database encoded.")

def classify_waste(image):
    """Classify uploaded waste image and return top-30 predictions"""
    if image is None:
        return None, "Please upload an image"
    
    # Preprocess
    pixel_values = processor(images=image, return_tensors="pt").pixel_values.to(DEVICE)
    
    # Inference
    with torch.no_grad():
        q_vectors = model.forward_image(pixel_values)
        scores = model.score(q_vectors, cached_k)
    
    # Get top-30
    top30_scores, top30_indices = scores[0].topk(30)
    
    # Build a nice markdown table for the top 30
    md_content = "### 📊 Top 30 Retrieval Results\n\n"
    md_content += "| Rank | Item | Category | Confidence |\n"
    md_content += "|:---:|:---|:---|:---:|\n"
    
    top_result_info = ""
    
    for i, (idx, score) in enumerate(zip(top30_indices.cpu().numpy(), top30_scores.cpu().numpy())):
        item_name = items[idx]
        category = df.iloc[idx]['Category']
        instruction = df.iloc[idx]['Instruction_1']
        conf = float(score)
        
        # Table row
        md_content += f"| {i+1} | {item_name} | {category} | {conf:.2f} |\n"
        
        # Detailed Card for Top 3
        if i < 3:
            top_result_info += f"#### 🏆 Top Pick #{i+1}: {item_name}\n"
            top_result_info += f"**Category:** {category}  \n"
            top_result_info += f"**How to dispose:** {instruction}\n\n"

    final_output = f"{top_result_info}\n---\n{md_content}"
    return final_output

# Create Gradio interface
with gr.Blocks(theme=gr.themes.Soft(), css=".gradio-container {max-width: 1000px !important} .top-results {height: 600px; overflow-y: auto;}") as demo:
    gr.Markdown("# 🗑️ QK Fusion V2.3: Waste Wizard Demo")
    gr.Markdown("Upload an image of any household waste item to find its category and disposal instructions among **2,205 categories**.")
    
    with gr.Row():
        with gr.Column(scale=1):
            input_img = gr.Image(type="pil", label="Upload Photo")
            btn = gr.Button("⚡ Classify Item", variant="primary")
        
        with gr.Column(scale=2):
            output_md = gr.Markdown(label="Results", elem_classes=["top-results"])

    btn.click(fn=classify_waste, inputs=input_img, outputs=output_md)
    
    gr.Markdown("---")
    gr.Markdown("*Powered by QK Fusion V2.3 (DINOv2-Large + BGE-Large-v1.5)*")

if __name__ == "__main__":
    print(f"\nStarting demo on http://localhost:7862")
    demo.launch(server_name="127.0.0.1", server_port=7862, share=False)
