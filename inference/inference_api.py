#api for the server 
import io
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
import torch
import os
from inference.inference import load_resources, encode_database, classify

app = FastAPI()

# Add CORS middleware to allow requests from your frontend domain
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://site.biswa.ca",
        "https://biswa.ca",
        "http://localhost:8080",  # For local development
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Load model and resources at startup
print("Loading resources...")
model, processor, tokenizer, df = load_resources()

if model is None or df is None:
    raise RuntimeError(
        "Failed to load model or CSV. Check that v2_frozen_ep25.pth and waste-wizard.csv exist in the project root."
    )

print("Encoding database...")
cached_k = encode_database(model, tokenizer, df)
print("Server ready!")

@app.post("/predict")
async def predict(file: UploadFile = File(...)):
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="File must be an image.")
    try:
        image_bytes = await file.read()
        # Save to a temporary file
        import tempfile
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
            tmp.write(image_bytes)
            tmp_path = tmp.name
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid image: {e}")
    try:
        results = classify(tmp_path, model, processor, cached_k, df)
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
    if results is None:
        raise HTTPException(status_code=400, detail="Failed to classify image.")
    return JSONResponse(content={"results": results})
