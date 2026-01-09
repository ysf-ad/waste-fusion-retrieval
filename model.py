import torch
import torch.nn as nn
import torch.nn.functional as F
from transformers import AutoModel, AutoProcessor, SiglipVisionModel

class CrossAttentionMatcher(nn.Module):
    def __init__(
        self,
        text_model_id="BAAI/bge-large-en-v1.5",
        image_model_id="facebook/dinov2-large",
        shared_dim=1024,
        head_dim=1024,
        num_heads=4,
        dropout=0.1
    ):
        super().__init__()
        self.shared_dim = shared_dim
        self.head_dim = head_dim
        self.num_heads = num_heads

        # 1. Frozen Encoders
        print(f"Loading Text Encoder: {text_model_id}...")
        self.text_encoder = AutoModel.from_pretrained(text_model_id)
        self.text_dim = self.text_encoder.config.hidden_size
        
        print(f"Loading Image Encoder: {image_model_id}...")
        self.image_encoder = AutoModel.from_pretrained(image_model_id)
        self.image_dim = self.image_encoder.config.hidden_size

        # Freeze encoders
        for p in self.text_encoder.parameters(): p.requires_grad = False
        for p in self.image_encoder.parameters(): p.requires_grad = False

        # 2. Trainable Projections
        # Text Projection: d_txt -> d (Linear only - BGE embeddings are already semantic)
        self.W_t = nn.Linear(self.text_dim, shared_dim)
        
        # Image Projection: d_img -> d (MLP for capacity)
        self.W_img = nn.Sequential(
            nn.Linear(self.image_dim, shared_dim),
            nn.GELU(),
            nn.Linear(shared_dim, shared_dim)
        )

        # Cross-Attention Projections
        # Pooling Mechanism: Attention Pooling (B, P, d) -> (B, H, d)
        self.pooling_queries = nn.Parameter(torch.randn(num_heads, shared_dim)) # (H, d)
        
        # Attention Projections for the Retrieval Score
        self.W_q = nn.Linear(shared_dim, head_dim)
        self.W_k = nn.Linear(shared_dim, head_dim)
        
        # Temperature Scaling (Learnable)
        self.logit_scale = nn.Parameter(torch.ones([]) * 4.605)
        
        self.dropout = nn.Dropout(dropout)

    def set_trainable_backbone(self, last_n_blocks=4):
        """
        Unfreeze the last N blocks of DINOv2 for fine-tuning.
        """
        # DINOv2 blocks are in self.image_encoder.encoder.layer
        for p in self.image_encoder.parameters():
            p.requires_grad = False
            
        layers = self.image_encoder.encoder.layer
        total_layers = len(layers)
        
        for i in range(total_layers - last_n_blocks, total_layers):
            for p in layers[i].parameters():
                p.requires_grad = True
        
        # Also unfreeze head/layernorm if needed
        for p in self.image_encoder.layernorm.parameters():
            p.requires_grad = True
            
        print(f"Unfrozen the last {last_n_blocks} blocks of DINOv2.")
        
    def encode_text(self, input_ids, attention_mask):
        """
        Offline Step: Produces T (N, d) -> and then K (N, d_k)
        Returns: K matrix (Batch, d_k)
        """
        with torch.no_grad():
            outputs = self.text_encoder(input_ids, attention_mask=attention_mask)
            token_embeddings = outputs.last_hidden_state
            input_mask_expanded = attention_mask.unsqueeze(-1).expand(token_embeddings.size()).float()
            sum_embeddings = torch.sum(token_embeddings * input_mask_expanded, 1)
            sum_mask = torch.clamp(input_mask_expanded.sum(1), min=1e-9)
            t_raw = sum_embeddings / sum_mask # (B, d_txt)

        # Trainable Projection
        t = self.W_t(t_raw) # (B, d)
        t = F.normalize(t, p=2, dim=-1)
        
        # Project to Key Space
        k = self.W_k(t) # (B, d_k)
        return k

    def forward_image(self, pixel_values):
        """
        Online Step part A: Image -> Q vectors
        Returns: Q (B, H, d)
        """
        with torch.no_grad():
            outputs = self.image_encoder(pixel_values=pixel_values)
            z_patches = outputs.last_hidden_state # (B, P, d_img)
        
        # Project Patches
        z = self.W_img(z_patches) # (B, P, d)
        
        # Pooling: Map P patches -> H heads
        # Compute attention weights: (B, H, d) @ (B, d, P) -> (B, H, P)
        queries = self.pooling_queries.unsqueeze(0).expand(z.shape[0], -1, -1) # (B, H, d)
        attn_scores = torch.bmm(queries, z.transpose(1, 2)) / (self.shared_dim ** 0.5) 
        attn_weights = F.softmax(attn_scores, dim=-1) # (B, H, P)
        
        # Aggregate Patches: (B, H, P) @ (B, P, d) -> (B, H, d)
        q_vectors = torch.bmm(attn_weights, z)
        q_vectors = F.normalize(q_vectors, p=2, dim=-1)
        return q_vectors

    def score(self, q_vectors, cached_k):
        """
        Online Step part B: Cross-Attention Scoring
        q_vectors: (B, H, d)
        cached_k: (N_rows, d_k)
        Returns: scores (B, N_rows)
        """
        # Project Queries to Key Dimension
        q_k = self.W_q(q_vectors) # (B, H, d_k)
        
        # Compute Scores
        # cached_k is (N, d_k), transpose to (d_k, N)
        k_t = cached_k.transpose(0, 1) # (d_k, N)
        
        # Logit Scale (Temperature)
        logit_scale = self.logit_scale.exp()
        scores_raw = torch.matmul(q_k, k_t) * logit_scale
        
        # Aggregate Heads (Mean over heads)
        scores_agg = scores_raw.mean(dim=1) # (B, N)
        
        return scores_agg

    def forward(self, pixel_values, input_ids_list=None, attention_mask_list=None, cached_k=None):
        """
        Full Forward Pass (for training) or Inference
        """
        # B = batch size of images
        q_vectors = self.forward_image(pixel_values) # (B, H, d)
        
        if cached_k is None:
            # If training, we might compute K on the fly for the batch of labels
            # But usually we train against the FULL set of rows (InfoNCE vs all negatives)
            # or in-batch negatives. 
            # For this specific architecture, we assume N rows are provided or pre-cached.
            if input_ids_list is not None:
                 cached_k = self.encode_text(input_ids_list, attention_mask_list)
            else:
                raise ValueError("Must provide either cached_k or text inputs")
                
        scores = self.score(q_vectors, cached_k)
        return scores
