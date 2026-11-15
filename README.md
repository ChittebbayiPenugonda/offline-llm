# Offline LLM

A clean, chat-style web UI for running open-source models **entirely on your Mac**, with no internet and no accounts. Nothing leaves your machine.

It talks to [LM Studio](https://lmstudio.ai) over its local OpenAI-compatible API, and adds a small Mac hardware bridge so the app can see your Apple Silicon chip, memory and GPU, and load models with **full Metal GPU offload**.

## Features

- Streaming chat with Markdown, tables and syntax-highlighted code (with copy buttons)
- Conversation history saved locally in your browser
- Model picker showing format (**MLX** / GGUF), quantization, size, and whether it fits in GPU memory
- **Mac hardware panel**: chip, unified memory, GPU cores, macOS GPU memory budget, and a live memory estimate for model + context
- One-click **Load on GPU (Metal)**: runs `lms load --gpu max` with your chosen context length, and unloads other models first so a 16 GB Mac isn't squeezed
- Auto-loads the selected model on the GPU before your first message
- Tokens/sec, token count and time-to-first-token on each reply
- Collapsible "thinking" view for reasoning models (`<think>` tags or `reasoning_content`)
- Image input for vision models (drag & drop, paste, or 📎)
- Stop, retry, system prompt, temperature, max tokens
- Light and dark mode; works on narrow windows

## Run it

**Requirements:** an Apple Silicon Mac, [LM Studio](https://lmstudio.ai) (open it once so it installs the `lms` CLI), and Node.js 20+.

```bash
npm install          # one time, needs internet
npm start            # builds and opens http://localhost:5173
```

Or double-click **`start.command`** in Finder. It starts LM Studio's server and the app together.

After `npm install` and downloading a model, everything works **with Wi-Fi off**: there are no CDNs, web fonts or telemetry, and all libraries are bundled locally. You don't need to know LM Studio's port, because the app reads it from `lms server status`.

For development with hot reload, use `npm run dev`.

## Getting the most out of your Mac

Apple Silicon shares one pool of **unified memory** between the CPU and GPU. By default, macOS lets the GPU use about **⅔ of RAM** on Macs with 36 GB or less (≈10.7 GB on a 16 GB Mac). Models that fit inside that budget run entirely on the GPU and are much faster.

1. **Prefer MLX models.** In LM Studio's model search, filter by **MLX**. MLX is Apple's own ML framework for M-series chips, and it's usually faster than GGUF (llama.cpp) on a Mac. Both formats run on the Metal GPU.
2. **Use 4-bit quantization** (MLX `4bit`, or GGUF `Q4_K_M`). It's the best balance of quality and memory.
3. **Size models to your RAM:**

   | Unified memory | Runs well (4-bit) | Possible |
   |---|---|---|
   | 16 GB | 3B–8B models (e.g. Qwen3 8B, Llama 3.1 8B, Gemma 3 4B) | 12–14B with ≤ 8k context |
   | 24–32 GB | up to 14B | 24–32B with short context |
   | 64 GB+ | 30B+ and mixture-of-experts models | 70B 4-bit |

4. **Keep context modest.** The KV cache grows with context length. 8k is a good default. The hardware panel shows the estimate before you load.
5. Close memory-heavy apps before loading large models, so the model doesn't push the system into swap.

## Is LM Studio the right backend?

For a Mac, yes. It's the most convenient option:

- It ships **both** the MLX engine and llama.cpp with Metal, so you get the fastest Apple Silicon path without any setup.
- It has a model browser with RAM-fit hints, and a scriptable CLI (`lms`) that this app uses for GPU loading.
- It provides an OpenAI-compatible API, so this UI isn't locked to it.

Alternatives:

- **Ollama**: simple and headless, but it mostly uses GGUF/llama.cpp, so it's usually a bit slower than MLX on a Mac.
- **`mlx_lm.server`**: raw MLX from Python. It's the leanest option, but you manage models yourself.

To use one of these, create a `.env` file:

```
LLM_SERVER=http://localhost:11434   # Ollama (or http://localhost:8080 for mlx_lm.server)
```

Chat works with any OpenAI-compatible server. The hardware panel's GPU-loading buttons are LM Studio-only.

## How it works

```
Browser UI (React)  ──/llm/*────▶  Vite server  ──▶  LM Studio API (localhost, port auto-detected)
                    ──/local/*──▶  macBridge    ──▶  sysctl / system_profiler / lms CLI
```

- [`server/macBridge.ts`](server/macBridge.ts): a Vite plugin that serves hardware info, proxies the model API (so there are no CORS issues), and runs `lms` with fixed arguments. Model names are checked against `lms ls`. State-changing calls require a custom header, so other websites can't trigger them.
- [`src/api.ts`](src/api.ts): streaming client, think-tag parsing and token stats.
- [`src/App.tsx`](src/App.tsx), [`src/components/`](src/components): the UI.

The server listens on `localhost` only.
