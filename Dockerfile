FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04

# Set working directory first
WORKDIR /app

# Update system packages
RUN apt-get update && apt-get install -y \
    python3-pip python3-dev git && \
    rm -rf /var/lib/apt/lists/*

# Install Python dependencies (cached layer - only rebuilds if requirements.txt changes)
COPY requirements.txt .
RUN pip3 install --upgrade pip && \
    pip3 install -r requirements.txt

# Copy application code (this layer rebuilds on code changes)
COPY . .

# Expose port
EXPOSE 9000

# Default command (overridden by docker-compose for development)
CMD ["uvicorn", "inference.inference_api:app", "--host", "0.0.0.0", "--port", "9000"]