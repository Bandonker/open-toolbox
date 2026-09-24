import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from PIL import Image, ImageDraw, ImageFont
import textwrap, os

OUT = r"F:\aicoder\opencodePlugins\images"

def text_image(path, title, body, width=1400, fontsize=22):
    try:
        font = ImageFont.truetype("consola.ttf", fontsize)
        font_b = ImageFont.truetype("consolab.ttf", fontsize + 4)
    except Exception:
        font = ImageFont.load_default()
        font_b = font
    lines = body.split("\n")
    tmp = Image.new("RGB", (width, 10), "white")
    d = ImageDraw.Draw(tmp)
    lh = fontsize + 8
    # wrap long lines
    wrapped = []
    for ln in lines:
        wrapped += textwrap.wrap(ln, width=110) or [""]
    h = 120 + lh * len(wrapped)
    img = Image.new("RGB", (width, h), "white")
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, width, 90], fill=(22, 19, 16))
    d.text((24, 24), title, fill="white", font=font_b)
    y = 110
    for ln in wrapped:
        d.text((24, y), ln, fill=(22, 19, 16), font=font)
        y += lh
    img.save(path)
    print("saved", path, img.size)

summary = """Lifetime
  tokens: input=46542455 output=709300 reasoning=924987 cache_read=148895718 cache_write=1398
  cost: $6.365236 | cost (list price): $5.732849
  unknown models: 4 (no published pricing)
  sessions: 132
  tool calls: 2949 (ok 2906, failed 43, 98.5% success)
  background: tokens=0 cost=$0.000000 (title=0 compaction=0)

Today (2026-09-23)
  tokens: input=3639755 output=158157 reasoning=116893 cache_read=32590845 cache_write=0
  cost: $0.153276 | tool calls: 620"""

tokens = """Token usage by day (last 30 days)
  2026-09-21: tokens=153251937 cost=$6.182367 calls=2062
  2026-09-22: tokens=7316271 cost=$0.029594 calls=267
  2026-09-23: tokens=36505650 cost=$0.153276 calls=620

By model:
  deepseek-v4.1-flash: 93.1m tokens, $5.542267, 975 events
  unknown: 53.6m tokens, $0.631792, 289 events
  muse-spark-1.3-contributor-free: 27.3m tokens, $0, 284 events
  muse-spark-1.3-contributor#medium: 13.3m tokens, $0.159678, 323 events
  qwen3.5-9b: 6.1m tokens, $0, 283 events
  inkling:free: 2.2m tokens, $0, 89 events
  mimo-v2.6-flash-free: 521k, $0, 6 events
  mimo-v2.6-flash: 444k, $0.024431, 12 events"""

tools = """Tool usage (top)
  read: 858 (ok 851, fail 7) avg 110ms max 30.4s
  shell: 799 (ok 799) avg 4.2s max 4.9m
  edit: 577 (ok 559, fail 18) avg 47ms
  grep: 256 ok, avg 69ms
  execute: 181 ok, avg 91ms
  write: 75 ok | glob: 36 | webfetch: 24 | websearch: 16
  question: 15 (avg 5.9m) | skill: 8 (8 failed)

Heatmap (12 weeks, tokens): peak 2026-09-21 (153m); Total 197073858
  Mon [....heavy....####]  Tue/Wed recent activity

Tool-call audit (trace_stats)
  calls: 3612 | errors: 45 | sessions: 85 | tools: 39
  window: 2026-09-21 -> 2026-09-23 | store 2.7 MB
  slowest: question 46.6m, question 27.0m, session_handoff 15.0m, shell 5.0m"""

text_image(os.path.join(OUT, "usage-stats-summary.png"),
           "Usage stats - summary + tokens + models",
           summary + "\n\n" + tokens)
text_image(os.path.join(OUT, "usage-stats-tools-trace.png"),
           "Usage stats - tools + heatmap + audit",
           tools)

# Dashboard-style chart: tokens per day bars + KPIs
fig, ax = plt.subplots(figsize=(14, 7))
fig.patch.set_facecolor("#fdfcf7")
ax.set_facecolor("#fdfcf7")
days = ["2026-09-21", "2026-09-22", "2026-09-23"]
vals = [153251937, 7316271, 36505650]
bars = ax.bar(days, vals, color=["#161310", "#161310", "#a92c1a"])
ax.set_title("Usage stats dashboard - tokens per day (197m lifetime / $6.37 / 132 sessions / 2949 calls, 98.5% ok)",
             fontsize=11, loc="left")
ax.set_ylabel("tokens")
for b, v in zip(bars, vals):
    ax.text(b.get_x() + b.get_width()/2, b.get_height(), f"{v/1e6:.1f}m",
            ha="center", va="bottom", fontsize=10)
fig.tight_layout()
p = os.path.join(OUT, "usage-stats-dashboard.png")
fig.savefig(p, dpi=150)
print("saved", p)
