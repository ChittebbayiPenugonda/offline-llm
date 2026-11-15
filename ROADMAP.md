# Roadmap

## Vision

A **local-first AI assistant built on open-weight models**. It should feel like a full AI chat app (web search, files, long conversations) and like a terminal coding agent (reads, edits and runs code in your projects). You choose where the model runs: on your Mac, on rented cloud GPUs, or through a hosted open-weight API. You switch between them with one toggle.

Principles:

- **The model runs on your computer by default**, and it can still use the internet. "Where the model runs" and "whether it can go online" are separate settings:

  | | Internet tools on (default) | Offline mode |
  |---|---|---|
  | **Local model** | Model on your Mac; it can search and read the web. Only search queries and page downloads leave the machine. | Nothing leaves the machine; works on a plane |
  | **Cloud model** | Model on a rented GPU or hosted API, with web access | Not possible |

- **Offline mode is an option, not a limitation.** Turn it on for privacy or when there's no Wi-Fi, and every outside request is blocked.
- **Open-weight models only** (Qwen, Llama, Gemma, Mistral, gpt-oss, DeepSeek…). No lock-in to one vendor.
- **One standard API everywhere.** Every backend speaks the OpenAI-compatible chat API, so features work the same wherever the model runs.
- **You stay in control.** The agent asks before running commands or changing files, and the UI always shows where your data is going.

## Where things stand (v0.1)

- [x] Chat UI with streaming, Markdown, code highlighting, history and images
- [x] LM Studio backend, with the port detected automatically
- [x] Apple Silicon awareness: GPU memory budget, fit estimates, full Metal offload
- [x] Starts LM Studio automatically and puts it back the way it was on exit
- [x] Fully offline once installed

## Goal 1: Switchable compute ("where does the model run?")

A toggle in the top bar, per chat:

| Backend | What it is | Internet? | Cost |
|---|---|---|---|
| **This Mac (LM Studio)** | Current default; MLX and llama.cpp on the Metal GPU | No | Free |
| **This Mac (Ollama / `mlx_lm.server`)** | Alternative local engines | No | Free |
| **Cloud GPU (Brev, RunPod, Lambda…)** | Rent an NVIDIA GPU and run vLLM or SGLang on it; the app connects to it | Yes | Hourly |
| **Hosted open-weight API (OpenRouter, Together, Groq…)** | Someone else runs the model; you call an API | Yes | Per token |
| **Google Colab** *(experimental)* | Free or cheap GPU notebook exposed through a tunnel | Yes | Free/cheap |

To do:

- [ ] Add a provider layer: each backend has a name, base URL, API key (kept in the macOS Keychain, not in the browser), model list and health check
- [ ] Add a backend switcher in the UI with a clear "Local" or "Cloud" badge, and confirm before sending a local chat's history to a cloud backend
- [ ] Add an **Offline mode** switch (separate from the backend toggle) that blocks every non-localhost request
- [ ] Cloud GPU launcher: start a GPU instance, run vLLM with the chosen model, connect, show cost per hour, and **shut the instance down automatically** when the app closes or after it sits idle (like the LM Studio cleanup, but it saves money)
- [ ] Colab notebook template that serves a model through a tunnel. Free-tier sessions time out, and Colab isn't meant to be used as a server, so this is for experiments only.

Why it matters: a 16 GB Mac comfortably runs about 8B models. Cloud GPUs open up 30B–70B+ models, which are much better at agent and coding work.

## Goal 2: Full AI chat features

- [ ] **Web search**: works with the **local** model. The model decides when to search; the app runs the search, fetches the pages and hands the text back to the model, which answers with inline citations.
  - Search providers to choose from: **SearXNG** (self-hosted, free, private; runs locally in Docker), Brave Search API, or Tavily
  - Page fetching with readable-text extraction, so the model reads articles, not raw HTML
  - On by default, with a visible "Searching the web…" step showing each query and page; blocked only when Offline mode is on
- [ ] **Tool-calling foundation**: use the standard `tools` / `tool_calls` API, and show each tool call in the chat. Web search, files and the coding agent all build on this.
- [ ] Files and documents: drop in PDFs and text files, with local embeddings for search (LM Studio already has `nomic-embed-text`)
- [ ] Projects: group chats together, with shared instructions and files
- [ ] Live preview pane for HTML, React, SVG and Mermaid code the model writes
- [ ] Search and export conversations, and move storage from browser localStorage to a local database

## Goal 3: Coding agent (terminal-agent style)

- [ ] Agent loop on the local server (not in the browser): the model plans, calls tools, reads the results and repeats
- [ ] Tools: read, write and edit files (shown as diffs), list and search a project, run shell commands, and web search/fetch (from Goal 2)
- [ ] Permission prompts before any edit or command, a folder sandbox per project, and an "allow for this session" option
- [ ] Two front ends on one engine: an **agent mode in the web app** (with a diff view) and a **terminal CLI**
- [ ] Project context: read a `AGENTS.md`-style file for per-project instructions
- [ ] Model guidance: agents need models trained for tool calling (e.g. Qwen3 or Qwen-Coder, gpt-oss, Devstral). Small local models handle simple tasks; Goal 1 cloud backends handle bigger ones.

## Suggested order

1. **Provider layer and backend toggle** (Goal 1, local part). Everything else depends on it, and it's small.
2. **Tool-calling foundation and web search** (Goal 2). This is the first real tool and proves the agent loop.
3. **Coding agent** in the web app, then the CLI (Goal 3).
4. **Cloud backends**: hosted APIs first (easiest), then the GPU launcher with auto-shutdown.

## Architecture changes needed

- Promote the Vite plugin (`server/macBridge.ts`) to a standalone local server (Node, or Python for MLX/vLLM tooling). It would own providers, secrets, tools, the agent loop and storage. The browser and CLI become thin clients.
- Keep everything behind the OpenAI-compatible API so local, cloud and hosted backends stay interchangeable.
