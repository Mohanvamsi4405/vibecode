# VibeCode — AI-Powered Browser IDE

> Describe what you want. The AI builds it, writes the files, and runs it — all in your browser.

VibeCode is an open-source, self-hostable browser IDE where an AI agent generates full-stack web projects from natural language. You chat, the agent plans → codes → runs. No local setup, no framework installs, no context-switching.

**Live demo**: [vibecode-0a3x.onrender.com](https://vibecode-0a3x.onrender.com)

---

## What It Does

1. You type: _"Build me a music player with a playlist"_
2. The **planner** decides the project type (FastAPI backend + HTML/JS frontend)
3. The **coder** writes every file and streams them into the editor in real time
4. The **terminal agent** generates the exact shell command to install deps and start the server
5. The preview pane loads your running app through a built-in port proxy

All without leaving the browser.

---

## Features

- **AI agent pipeline** — LangGraph state machine: `intent → planner → coder → terminal`
- **WebSocket terminal** — real bash shell, live output, Ctrl+C support
- **Virtual file system** — in-browser editor with multi-file tabs (CodeMirror)
- **Port proxy** — preview FastAPI/Flask sub-projects via `/proxy/{port}/` on a single Render URL
- **Project memory** — per-project conversation history with LangGraph MemorySaver
- **Live streaming** — all agent steps stream via SSE; see files appear as the agent writes them
- **One-click deploy** — Dockerfile + render.yaml included for free-tier Render hosting

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | FastAPI + Python 3.10 |
| AI Agent | LangGraph + Groq API |
| LLMs | `llama-3.1-8b-instant` (intent/chat), `llama-3.3-70b-versatile` (planner/coder) |
| Frontend | Vanilla JS — no framework, no build step |
| Editor | CodeMirror (bundled) |
| Terminal | WebSocket → bash/cmd.exe subprocess |
| Deployment | Docker on Render free tier |

---

## Getting Started

### Prerequisites
- Python 3.10+
- A free [Groq API key](https://console.groq.com/)

### Run Locally

```bash
git clone https://github.com/Mohanvamsi4405/vibecode.git
cd vibecode/backend

pip install -r requirements.txt

# Create .env file
echo "GROQ_API_KEY=your_key_here" > .env

python main.py
# Open http://localhost:8001
```

### Run with Docker

```bash
docker build -t vibecode .
docker run -p 8001:8001 -e GROQ_API_KEY=your_key_here vibecode
```

### Deploy to Render (free)

1. Fork this repo
2. Create a new **Web Service** on [Render](https://render.com/) → connect your fork
3. Render detects `render.yaml` automatically — just add `GROQ_API_KEY` in Environment Variables
4. Deploy

---

## Project Structure

```
backend/
  main.py          — FastAPI app, WebSocket terminal, all API endpoints
  agent_service.py — LangGraph pipeline (intent → planner → coder → terminal)
  groq_service.py  — Groq API client wrapper
  schemas.py       — Pydantic request/response models
  requirements.txt — Python dependencies

vibecode/
  index.html       — Single-page shell
  script.js        — All frontend logic (~2800 lines)
  style.css        — All styles
  lucide.js        — Icon library

Dockerfile         — Docker build for cloud deployment
render.yaml        — Render free tier config
```

---

## How the Agent Pipeline Works

```
User message
     │
     ▼
  intent node
  ├── keyword match (fast, no LLM)
  └── LLM classify → chat | stop | build
         │
    ┌────┴─────┐
    │          │
  chat       stop      build
  (reply)   (kill     ┌────────────┐
            port)     │  planner   │ ← decides project type & file structure
                      └─────┬──────┘
                            │
                      ┌─────▼──────┐
                      │   coder    │ ← writes all files (streams file_write events)
                      └─────┬──────┘
                            │
                      ┌─────▼──────┐
                      │  terminal  │ ← generates shell commands (auto-run in terminal)
                      └────────────┘
```

Every node streams events to the frontend over SSE. Files appear in the editor as they're written.

---

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/` | Serves the IDE frontend |
| `POST` | `/api/chat` | Main SSE stream — runs the agent pipeline |
| `WS` | `/ws/terminal` | WebSocket shell terminal |
| `GET` | `/proxy/{port}/{path}` | Forwards requests to sub-project servers |
| `POST` | `/api/write-file` | Write a file to disk |
| `GET` | `/api/list-files` | List project files |
| `POST` | `/api/kill-port` | Kill process on a port |
| `GET` | `/api/check-port` | Check if a port is in use |
| `GET` | `/api/projects` | List all projects |

---

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for how to get started.

Good first issues are labeled [`good first issue`](../../issues?q=label%3A%22good+first+issue%22) on GitHub.

---

## License

MIT — see [LICENSE](LICENSE).
