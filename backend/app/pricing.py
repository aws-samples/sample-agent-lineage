"""Default LLM pricing (USD per 1k tokens), matched by model-id substring.

Used when the LLM node has no explicit `pricing_per_1k` facet — a node facet
always wins, so override per-model via the nodes API when your negotiated
rates differ. Prices are list prices and drift over time; treat as defaults.
"""
from typing import Optional

# (lowercase substring, input_usd_per_1k, output_usd_per_1k) — first match wins,
# so keep more specific substrings above generic ones.
DEFAULT_PRICING: list[tuple[str, float, float]] = [
    # Anthropic Claude (Bedrock)
    ("claude-haiku-4", 0.001, 0.005),
    ("claude-sonnet-4", 0.003, 0.015),
    ("claude-opus-4", 0.015, 0.075),
    ("claude-3-5-haiku", 0.0008, 0.004),
    ("claude-3-5-sonnet", 0.003, 0.015),
    ("claude-3-haiku", 0.00025, 0.00125),
    ("claude", 0.003, 0.015),
    # Amazon Nova
    ("nova-micro", 0.000035, 0.00014),
    ("nova-lite", 0.00006, 0.00024),
    ("nova-pro", 0.0008, 0.0032),
    ("nova-premier", 0.0025, 0.0125),
    # Meta Llama (Bedrock)
    ("llama3-70b", 0.00072, 0.00072),
    ("llama3-8b", 0.00022, 0.00022),
    ("llama", 0.0006, 0.0006),
    # Mistral
    ("mistral-large", 0.002, 0.006),
    ("mistral", 0.00015, 0.0002),
    # OpenAI
    ("gpt-4o-mini", 0.00015, 0.0006),
    ("gpt-4o", 0.0025, 0.01),
    ("gpt-4", 0.03, 0.06),
    # Google
    ("gemini-1.5-pro", 0.00125, 0.005),
    ("gemini", 0.000075, 0.0003),
]


def lookup(model_name: str) -> Optional[dict]:
    """Return {'input_usd': x, 'output_usd': y} per 1k tokens, or None."""
    name = (model_name or "").lower()
    for substring, inp, out in DEFAULT_PRICING:
        if substring in name:
            return {"input_usd": inp, "output_usd": out}
    return None


def cost_for(model_name: str, input_tokens: int, output_tokens: int) -> float:
    p = lookup(model_name)
    if not p:
        return 0.0
    return input_tokens / 1000 * p["input_usd"] + output_tokens / 1000 * p["output_usd"]
