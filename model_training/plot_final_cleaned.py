"""Generate final comparison plot with all models (Inverse-Log Y-Scale)"""
import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns
import os
from matplotlib.ticker import ScalarFormatter, FuncFormatter

# Set style
sns.set_theme(style="whitegrid")
plt.rcParams['figure.figsize'] = (12, 7)
plt.rcParams['font.size'] = 11

# Load results
clip_df = pd.read_csv('clip_recall_cleaned.csv')
dino_df = pd.read_csv('dino_recall_cleaned.csv')
v23_df = pd.read_csv('v23_recall_cleaned.csv')

# Plot
fig, ax = plt.subplots()

# We plot (100 - Recall) on a Log Scale
# This is the 'Error Rate' or 'Unrecalled %'
# A lower error rate is better.
def plot_error_log(df, label, color, marker):
    error = 100.0 - df['recall']
    # Small epsilon to avoid log(0)
    error = error.clip(lower=0.1)
    ax.plot(df['k'], error, marker=marker, linewidth=2.5, markersize=4, 
            label=label, color=color, alpha=0.9)

plot_error_log(clip_df, 'CLIP (Zero-Shot)', '#3498db', 'o')
plot_error_log(dino_df, 'DINO Linear (Supervised)', '#e74c3c', 's')
plot_error_log(v23_df, 'QK Fusion V2.3 (Ours)', '#2ecc71', 'D')

# Set Y-axis to Log Scale
ax.set_yscale('log')

# Format Y-axis to show RECALL values, not error values
# Recall = 100 - Error
def recall_formatter(y, pos):
    r = 100.0 - y
    return f'{r:g}%'

ax.yaxis.set_major_formatter(FuncFormatter(recall_formatter))

# Set custom Y ticks to show important recall landmarks
# Error values: 100 (0% recall), 50 (50% recall), 20 (80%), 10 (90%), 5 (95%), 2 (98%), 1 (99%), 0.1 (99.9%)
ax.set_yticks([100, 70, 50, 30, 20, 10, 5, 2])
ax.set_ylim(100, 1) # Invert axis so 100% recall (0 error) is at the top

# X-axis is linear
ax.set_xlim(0, 52)
ax.set_xticks([1, 10, 20, 30, 40, 50])

# Annotations for key metrics (Recall numbers)
for k_val in [1, 10, 30, 50]:
    v23_val = v23_df[v23_df['k'] == k_val]['recall'].values[0]
    clip_val = clip_df[clip_df['k'] == k_val]['recall'].values[0]
    dino_val = dino_df[dino_df['k'] == k_val]['recall'].values[0]
    
    # We annotate at the error position: 100.0 - val
    ax.annotate(f'{v23_val:.1f}%', xy=(k_val, 100.0 - v23_val), xytext=(0, 10), 
                textcoords='offset points', ha='center', fontsize=8, color='#2ecc71', fontweight='bold')
    
    ax.annotate(f'{clip_val:.1f}%', xy=(k_val, 100.0 - clip_val), xytext=(0, -15), 
                textcoords='offset points', ha='center', fontsize=8, color='#3498db')
    
    ax.annotate(f'{dino_val:.1f}%', xy=(k_val, 100.0 - dino_val), xytext=(0, -25), 
                textcoords='offset points', ha='center', fontsize=8, color='#e74c3c')

ax.set_xlabel('K (Number of Retrieved Items)', fontsize=12, fontweight='bold')
ax.set_ylabel('Recall Ratio (Inverse-Log Scale to 100%)', fontsize=12, fontweight='bold')
ax.set_title('Waste Classification Leaderboard - Error Rate Analysis', 
            fontsize=14, fontweight='bold', pad=15)
ax.legend(loc='lower left', fontsize=11, framealpha=0.95)
ax.grid(True, which="both", alpha=0.3, linestyle='--')

plt.tight_layout()

# Save to artifacts
output_path = os.path.join(
    r"C:\Users\yousi\.gemini\antigravity\brain\006914ba-020a-4188-b946-41e0659be569",
    "final_leaderboard_cleaned_inverse_log.png"
)
plt.savefig(output_path, dpi=300, bbox_inches='tight')
print(f"Saved to: {output_path}")

# Also save locally
plt.savefig('final_leaderboard_cleaned_inverse_log.png', dpi=300, bbox_inches='tight')
plt.close()

# Print summary table
print("\n=== Final Leaderboard (Cleaned Validation Set) ===")
print(f"{'Model':<30} {'R@1':<8} {'R@10':<8} {'R@30':<8} {'R@50':<8}")
print("-" * 72)

for name, df in [("CLIP (Zero-Shot)", clip_df), 
                    ("DINO Linear (Supervised)", dino_df),
                    ("QK Fusion V2.3 (Ours)", v23_df)]:
    r1 = df[df['k'] == 1]['recall'].values[0]
    r10 = df[df['k'] == 10]['recall'].values[0]
    r30 = df[df['k'] == 30]['recall'].values[0]
    r50 = df[df['k'] == 50]['recall'].values[0]
    print(f"{name:<30} {r1:<8.2f} {r10:<8.2f} {r30:<8.2f} {r50:<8.2f}")
