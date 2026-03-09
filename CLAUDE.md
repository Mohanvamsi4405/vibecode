# VibeCode — Claude Code Instructions

## Project Overview
VibeCode is an AI-powered browser IDE. Users describe what they want, the AI agent builds full-stack projects, writes files, and runs them in an interactive terminal — all inside a single-page web app.

## Stack
- **Backend**: FastAPI + Python (`backend/main.py`)
- **AI Agent**: LangGraph + Groq API (`backend/agent_service.py`)
- **Frontend**: Vanilla JS, no framework (`vibecode/script.js`, `vibecode/index.html`, `vibecode/style.css`)
- **Models**: Groq — `llama-3.1-8b-instant` (fast), `llama-3.3-70b-versatile` (strong)

## File Structure
```
backend/
  main.py          — FastAPI app, WebSocket terminal, all API endpoints
  agent_service.py — LangGraph pipeline: intent → chat/stop/planner/coder → terminal
  groq_service.py  — Groq client wrapper
  schemas.py       — Pydantic models
  requirements.txt — Python deps

vibecode/
  index.html  — Single page shell
  script.js   — All frontend logic (~2800 lines)
  style.css   — All styles
  lucide.js   — Icons

Dockerfile    — Docker build for Render deployment
render.yaml   — Render free tier config
```

## How to Run Locally
```bash
cd backend
pip install -r requirements.txt
# Create backend/.env with: GROQ_API_KEY=your_key
python main.py
# Open http://localhost:8001
```

## Key Architecture

### Agent Pipeline (LangGraph)
```
START → intent → chat | stop | planner → coder → terminal → END
```
- `intent`: keyword pre-check first (`_keyword_intent`), then LLM if needed
- `stop`: kills port 8000 directly, no LLM call
- `chat`: pure conversation, no file changes
- `planner`: decides project structure
- `coder`: writes/edits files, emits `file_write` events
- `terminal`: generates shell commands, emits `agent_shell_cmd` events

### Frontend Events (SSE stream)
Key events from backend → frontend:
- `agent_start` / `agent_done` — show/hide agent cards
- `file_write` — write file to virtual FS and editor
- `agent_shell_cmd` — auto-run command in terminal
- `agent_shell_kill` — signal server stopped
- `chat_text` — display AI chat message
- `pipeline_done` — show summary card with token usage

### WebSocket Terminal
- `/ws/terminal` — spawns `/bin/bash` (Linux) or `cmd.exe` (Windows)
- Messages: `{type: 'stdin', data}`, `{type: 'ctrl_c'}`
- Responses: `{type: 'started'}`, `{type: 'stdout', data}`, `{type: 'exit'}`

### Projects
- Stored in `vibecode_projects/<project_name>/`
- Frontend keeps a virtual FS in `Store.state.files`
- Conversation history in `.vc_history/<project>.json`

## Key Conventions

### Backend
- All streaming responses use SSE: `data: {json}\n\n`
- Token usage tracked manually: measure `time.time()` before/after Groq call
- Usage keys: `prompt_tokens`, `completion_tokens`, `total_tokens`, `elapsed_ms`
- Platform checks: `sys.platform == "win32"` for Windows-specific code
- Kill port: use `taskkill /F /T /PID` on Windows, `fuser -k` on Linux
- Logger name: `log = _make_logger("vibecode")`

### Frontend
- State: `Store.state` — `files`, `openFiles`, `activeProject`, `chatHistory`
- Terminal output: always use `_termAppend(text, cls)` — never write to DOM directly
- Port kill button: `#btn-kill-port` — shown when uvicorn starts, hidden when stopped
- Agent cards: `_makeAgentCard(agent, runId)` — unique `runId` per pipeline run
- Event handler: `_handleAgentEvent(event, project, runId)` switch-case

### Agent Prompts
- Coder always produces JSON: `{"files": {"path": "content"}, "commands": [...]}`
- Default stack: FastAPI + plain HTML/JS frontend (no React/Vue unless asked)
- No database by default — use in-memory or JSON file
- Every FastAPI app must have a root route `/` returning HTML or redirect
- Mount static files AFTER defining all API routes

## What NOT to Do
- Never use `wmic` (deprecated on Windows 11) — use PowerShell CIM or `taskkill`
- Never use `.Parent.Id` on `Get-Process` — returns empty on Win11, use `Get-CimInstance Win32_Process`
- Never hardcode `PORT=8001` for Render — Render injects its own `PORT` env var
- Never commit `code_env/`, `vibecode_projects/`, `.vc_history/`, `backend/.env`
- Never add React/Vue/npm unless user explicitly asks
- Never add a database unless user asks for data persistence

## Deployment (Render Free Tier)
- Docker runtime, `Dockerfile` at repo root
- Set `GROQ_API_KEY` as environment variable in Render dashboard
- Port: read from `os.environ.get("PORT", 8001)` — already done in `main.py`
- Projects are ephemeral (lost on restart) — no persistent disk on free tier
- Terminal works (spawns bash), kill-port uses `fuser` on Linux

## Common Issues & Fixes
| Problem | Fix |
|---|---|
| Token display shows 0 | Measure `time.time()` around Groq call, don't use `total_time` attribute |
| uvicorn respawns after kill | Kill parent PID first with `taskkill /T`, then worker |
| Wrong project running | Call `/api/kill-port` before typing new server command |
| `Get-NetTCPConnection` stale | Verify with `Get-Process -Id pid` after kill — stale entries are normal |
| `.Parent.Id` empty on Win11 | Use `Get-CimInstance Win32_Process` for `ParentProcessId` |
