FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04

# updating system
RUN apt-get update && apt-get install -y \
    python3-pip python3-dev git && \
    rm -rf /var/lib/apt/lists/*

# working directory
WORKDIR /app

# this installs dependencies
COPY requirements.txt .
RUN pip3 install --upgrade pip && pip3 install -r requirements.txt

# copy the code
COPY . .

# the port
EXPOSE 9000

# run the server
CMD ["uvicorn", "inference.inference_api:app", "--host", "0.0.0.0", "--port", "9000"]