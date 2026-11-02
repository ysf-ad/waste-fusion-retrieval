import torch
import torch.nn as nn
from transformers import AutoModel

class DinoLinearClassifier(nn.Module):
    def __init__(self, model_id="facebook/dinov2-large", num_classes=2205):
        super().__init__()
        print(f"Loading Frozen Backbone: {model_id}...")
        self.backbone = AutoModel.from_pretrained(model_id)
        # Freeze backbone
        for p in self.backbone.parameters():
            p.requires_grad = False
            
        self.embed_dim = self.backbone.config.hidden_size # 1024 for Large
        
        # Supervised Head
        self.head = nn.Linear(self.embed_dim, num_classes)
        
    def forward(self, pixel_values):
        # We use the [CLS] token or Mean Pool. 
        # DINOv2 works well with CLS or average of all tokens.
        # Let's use the average of all patch tokens + CLS for stability.
        outputs = self.backbone(pixel_values=pixel_values)
        last_hidden = outputs.last_hidden_state # (B, P+1, d)
        
        # Mean Pooling
        pooled = last_hidden.mean(dim=1) # (B, d)
        
        logits = self.head(pooled) # (B, 2205)
        return logits
