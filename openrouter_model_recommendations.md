# OpenRouter Model Replacement Recommendations for ScentBeam Beam Agent

This report evaluates alternative language models available on OpenRouter to replace the current default and strong models in the ScentBeam Beam Agent:
- **Claude Haiku 4.5** (Cheap orchestration tier)
- **Claude Sonnet 4.6** (Strong synthesis tier)

The goal is to maintain **90% to 95% equivalence** in reasoning state, functionality, tool-calling logic, and accuracy while optimizing performance and costs.

---

## 1. Overview of Current Models

The ScentBeam Beam Agent architecture splits tasks between two models:
1. **Cheap/Default Tier (Orchestration):** Runs a multi-turn tool-calling loop (calling `beam_get_user_context`, `beam_get_wardrobe`, `beam_search_catalog`, etc.) to collect today's weather, wardrobe data, and fragrance information.
2. **Strong/Synthesis Tier (Recommendation):** Runs a single, high-token synthesis call at the end of the run to generate a rich, personalized fragrance recommendation.

| Current Model | Role | OpenRouter Slug | Context Window | Input Cost / 1M | Output Cost / 1M |
|---|---|---|---|---|---|
| **Claude Haiku 4.5** | Multi-turn Tool Orchestration | `anthropic/claude-haiku-4.5` | 200,000 | **$1.00** | **$5.00** |
| **Claude Sonnet 4.6** | Final Recommendation Synthesis | `anthropic/claude-sonnet-4.6` | 1,000,000 | **$3.00** | **$15.00** |

---

## 2. Potential Replacements for Claude Haiku 4.5 (Cheap Tier)

The replacement model must have **excellent tool-calling accuracy** and low latency to drive the agent loop efficiently without dropping arguments or hallucinating function calls.

### A. Google: Gemini 2.5 Flash Lite (`google/gemini-2.5-flash-lite`)
* **Pricing:** **$0.10** / 1M input | **$0.40** / 1M output
* **Cost Difference:** **-90%** on inputs | **-92%** on outputs
* **Context Window:** 1,048,576 tokens
* **Why it fits:** 
  * Exceptionally low latency and high throughput.
  * Massive context window (1.04M vs Haiku's 200k) allows passing larger catalog tables.
  * Very strong native tool-calling performance.
  * **Recommendation:** **Highly Recommended** as the primary replacement for Haiku 4.5.

### B. OpenAI: GPT-4o-mini (`openai/gpt-4o-mini`)
* **Pricing:** **$0.15** / 1M input | **$0.60** / 1M output
* **Cost Difference:** **-85%** on inputs | **-88%** on outputs
* **Context Window:** 128,000 tokens
* **Why it fits:**
  * Industry-standard tool-calling accuracy with standard JSON schemas.
  * Extremely reliable and fast.
  * Fully compatible with OpenRouter's OpenAI-compatible adapter (`openRouterProvider.ts`).
  * **Recommendation:** **Excellent fallback/alternative** option.

### C. DeepSeek: DeepSeek V4 Flash (`deepseek/deepseek-v4-flash`)
* **Pricing:** **$0.09** / 1M input | **$0.18** / 1M output
* **Cost Difference:** **-91%** on inputs | **-96.4%** on outputs
* **Context Window:** 1,048,576 tokens
* **Why it fits:**
  * The cheapest option available with a 1M context.
  * Fast inference times due to its Mixture-of-Experts (MoE) architecture.
  * **Recommendation:** **Experimental**. Tool-calling reliability on complex, nested schemas should be verified in staging before production.

---

## 3. Potential Replacements for Claude Sonnet 4.6 (Strong Tier)

The replacement model must have **frontier reasoning capabilities**, excellent text generation aesthetics for final recommendations, and stable support for long-context generation.

### A. DeepSeek: DeepSeek V4 Pro (`deepseek/deepseek-v4-pro`)
* **Pricing:** **$0.435** / 1M input | **$0.87** / 1M output
* **Cost Difference:** **-85.5%** on inputs | **-94.2%** on outputs
* **Context Window:** 1,048,576 tokens
* **Why it fits:**
  * **Matches the user-indicated $0.45 target.**
  * High-intelligence model designed to rival Sonnet-class architectures on reasoning and coding.
  * Out-of-the-box support for 1M tokens.
  * Provides a massive cost reduction while maintaining high reasoning capabilities.
  * **Recommendation:** **Highly Recommended** as the budget-friendly replacement for Claude Sonnet 4.6.

### B. Google: Gemini 2.5 Pro (`google/gemini-2.5-pro`)
* **Pricing:** **$1.25** / 1M input | **$10.00** / 1M output
* **Cost Difference:** **-58.3%** on inputs | **-33.3%** on outputs
* **Context Window:** 1,048,576 tokens
* **Why it fits:**
  * Employs Google's native "thinking" mechanism, creating structured internal reasoning prior to output.
  * Exceptional formatting and creative text synthesis, ideal for personalized fragrance write-ups.
  * Large context window of 1.04M tokens.
  * **Recommendation:** **Highly Recommended** if rich reasoning and output formatting quality are prioritized.

### C. DeepSeek: DeepSeek R1 (`deepseek/deepseek-r1`)
* **Pricing:** **$0.70** / 1M input | **$2.50** / 1M output
* **Cost Difference:** **-76.6%** on inputs | **-83.3%** on outputs
* **Context Window:** 163,840 tokens
* **Why it fits:**
  * Generates raw "thinking tokens" showing its step-by-step logic, which OpenRouter can stream to the client.
  * Frontier reasoning on par with OpenAI o1/o3 and Claude Opus, making it mathematically superior at scoring and correlating scent facts.
  * **Recommendation:** **Strong alternative** if deep reasoning trace is desirable for the user interface.

---

## 4. Model Comparison Matrix

The table below summarizes the key trade-offs between the current setup and proposed alternatives:

| Tier | Model ID | Input Cost / 1M | Output Cost / 1M | Context Window | Tool Calling Accuracy | Latency | Recommendation |
|---|---|---|---|---|---|---|---|
| **Haiku 4.5 (Current)** | `anthropic/claude-haiku-4.5` | $1.00 | $5.00 | 200k | SOTA | Very Low | *Baseline* |
| **Cheap Alternative 1** | `google/gemini-2.5-flash-lite` | $0.10 | $0.40 | 1M | High | Ultra-Low | **Primary Choice** |
| **Cheap Alternative 2** | `openai/gpt-4o-mini` | $0.15 | $0.60 | 128k | SOTA | Very Low | **Strong Fallback** |
| **Cheap Alternative 3** | `deepseek/deepseek-v4-flash` | $0.09 | $0.18 | 1M | Medium | Very Low | **Experimental** |
| **Sonnet 4.6 (Current)** | `anthropic/claude-sonnet-4.6` | $3.00 | $15.00 | 1M | SOTA | Medium | *Baseline* |
| **Strong Alternative 1** | `deepseek/deepseek-v4-pro` | $0.435 | $0.87 | 1M | High | Medium | **Budget Choice (~$0.45)** |
| **Strong Alternative 2** | `google/gemini-2.5-pro` | $1.25 | $10.00 | 1M | High | Medium | **Quality Choice** |
| **Strong Alternative 3** | `deepseek/deepseek-r1` | $0.70 | $2.50 | 163k | High | High (Thinking) | **Deep Reasoning Choice** |

---

## 5. Architectural Compatibility Analysis

The ScentBeam backend uses `openRouterProvider.ts` to translate Claude-style payloads into OpenAI completions.

> [!NOTE]
> **OpenAI Compatibility:** Because `openRouterProvider.ts` translates tool-calling schemas to the standard OpenAI format on the wire, all listed models from OpenAI, Google, and DeepSeek are structurally compatible with the adapter out-of-the-box.

### Potential Implementation Adjustments:
1. **Arg Parsing Safety (`safeParseArgs`):**
   Some alternative models (especially smaller Flash models) may occasionally return slightly malformed JSON or miss required keys. The backend's recent hardening pass (returning `is_error` instead of crashing) will successfully handle this by letting the model retry.
2. **System Instruction Truncation:**
   Haiku 4.5 and Sonnet 4.6 are highly resilient to complex system prompts. If switching to `gemini-2.5-flash-lite`, the system prompt should be monitored for instruction adherence, particularly regarding catalog exclusion rules.
3. **Synthesis Streaming:**
   If using `deepseek-r1`, the thinking blocks (`<thinking> ... </thinking>`) will be streamed. The client-side UI would need to either filter these out or display them as an expandable accordion.

---

## 6. Implementation Action Plan

To swap the models, configure the environment variables in `ScentCast.env` or `.env`:

```env
# New Cost-Optimized Setup
BEAM_AGENT_MODEL=google/gemini-2.5-flash-lite
BEAM_AGENT_MODEL_STRONG=deepseek/deepseek-v4-pro
```

Alternatively, if quality remains the absolute priority:

```env
# Quality-Focused Alternative Setup
BEAM_AGENT_MODEL=openai/gpt-4o-mini
BEAM_AGENT_MODEL_STRONG=google/gemini-2.5-pro
```
