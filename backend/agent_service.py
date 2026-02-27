"""
VibeCode Multi-Agent Pipeline  (v2 — unified coder)
────────────────────────────────────────────────────
Agents:
  Orchestrator  – analyses request, picks build strategy
  FullStack     – generates ALL files (main.py + templates + static) in one shot
  Frontend      – pure HTML/CSS/JS projects (no backend)
  Coder         – targeted edits / Python scripts
  Terminal      – determines shell commands
  Reviewer      – quality check (skipped for edits)

Key change from v1:
  Full-stack projects → ONE "fullstack" agent call instead of separate frontend+backend.
  This guarantees: endpoints match fetch() calls, correct paths, 2x fewer tokens.
"""

import os, json, re, logging, asyncio, time
from groq import Groq
from dotenv import load_dotenv
from typing import Dict, List, Optional, AsyncGenerator
from datetime import datetime
from pathlib import Path

log = logging.getLogger("vibecode")
load_dotenv()
_groq = Groq(api_key=os.getenv("GROQ_API_KEY"))

FAST_MODEL = "llama-3.1-8b-instant"

# ─── System Prompts ───────────────────────────────────────────────────────────

ORCHESTRATOR_PROMPT = """You are the Orchestrator for VibeCode IDE.
Analyse the user request and produce a build plan.

Output ONLY JSON (no markdown fences):
{
  "thinking": "brief reasoning",
  "project_type": "full_stack | web_only | python | api_only | edit | chat",
  "terminal_needed": true | false,
  "message": "One sentence: what will be built (or conversational response if chat)"
}

TERMINAL NEEDED RULES:
- Set to true if the user asks to "run", "start", "install", "stop", "kill", "restart", "test", "delete", "remove", "mkdir", "folder", "directory", "clean", or "clear".
- Set to true for ALL new "full_stack" or "python" projects.

PROJECT TYPE RULES:
- full_stack  → FastAPI backend serving Jinja2 templates + static JS/CSS
- web_only    → pure HTML/CSS/JS, no backend
- python      → Python script or CLI tool
- api_only    → FastAPI backend, no HTML frontend
- edit        → small targeted change to existing code
- chat        → greetings, questions about the project, non-coding requests
"""

FULLSTACK_PROMPT = """You are the FullStack Builder for VibeCode IDE.
Build a COMPLETE, WORKING full-stack app in a single response.

You must output ALL of these files every time:
1. {project}/main.py          — FastAPI backend
2. {project}/templates/index.html — HTML page (served by FastAPI)
3. {project}/static/style.css — all CSS
4. {project}/static/script.js — all JavaScript
5. {project}/requirements.txt — pip packages

Output ONLY JSON (no markdown fences):
{
  "actions": [
    {"action":"add_file","file":"{project}/main.py","content":"COMPLETE PYTHON"},
    {"action":"add_file","file":"{project}/templates/index.html","content":"COMPLETE HTML"},
    {"action":"add_file","file":"{project}/static/style.css","content":"COMPLETE CSS"},
    {"action":"add_file","file":"{project}/static/script.js","content":"COMPLETE JS"},
    {"action":"add_file","file":"{project}/requirements.txt","content":"PACKAGES"}
  ],
  "message": "Built: [description]"
}

════════════════════════════════════════
BACKEND RULES (main.py)
════════════════════════════════════════
1. BARE directory names — uvicorn runs from INSIDE the project folder:
     templates = Jinja2Templates(directory="templates")   ← CORRECT
     app.mount("/static", StaticFiles(directory="static")) ← CORRECT
     Jinja2Templates(directory="myapp/templates")          ← WRONG, crashes

2. File structure template — copy this exactly:
     from fastapi import FastAPI, Request, HTTPException
     from fastapi.responses import HTMLResponse
     from fastapi.staticfiles import StaticFiles
     from fastapi.templating import Jinja2Templates
     from pydantic import BaseModel
     from typing import List
     import uvicorn

     app = FastAPI()
     templates = Jinja2Templates(directory="templates")

     # --- in-memory data ---
     items: List[dict] = []
     _id = 1

     # --- root route ---
     @app.get("/", response_class=HTMLResponse)
     async def index(request: Request):
         return templates.TemplateResponse("index.html", {"request": request})

     # --- API routes (all prefixed /api/) ---
     @app.get("/api/items")
     def get_items(): ...

     @app.post("/api/items", status_code=201)
     def create_item(body: ItemIn): ...

     @app.delete("/api/items/{item_id}")
     def delete_item(item_id: int): ...

     # --- static AFTER routes ---
     app.mount("/static", StaticFiles(directory="static"), name="static")

     if __name__ == "__main__":
         uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)

3. ALL API endpoints use /api/ prefix: /api/items, /api/users, /api/products etc.
4. Use in-memory Python list for data. NO SQLite/database unless user explicitly asks.
5. Pydantic model for every request body.
6. HTTPException for errors. No bare try/except on every route.
7. requirements.txt = fastapi, uvicorn[standard], jinja2, python-multipart

════════════════════════════════════════
FRONTEND RULES (templates/index.html + static/)
════════════════════════════════════════
1. HTML links MUST use /static/ prefix (FastAPI serves from /static/):
     <link rel="stylesheet" href="/static/style.css">   ← CORRECT
     <script src="/static/script.js"></script>           ← CORRECT
     <link href="style.css">                             ← WRONG, 404

2. All fetch() calls use relative /api/ paths:
     fetch('/api/items')                  ← CORRECT
     fetch('http://localhost:8000/items') ← WRONG

3. Every fetch() must:
   - Show a loading state (disable button or show spinner)
   - await the response
   - check response.ok before using data
   - catch errors and show user-friendly message

4. DELETE pattern (always await before refreshing UI):
     const res = await fetch(`/api/items/${id}`, {method:'DELETE'});
     if (res.ok) await loadItems();

5. CSS: define variables in :root, NOT body. Use Inter font from Google Fonts.

6. UI quality bar — every project must look like a real SaaS app:
   - Dark theme: bg=#0f172a, surface=#1e293b, primary=#7c3aed, accent=#22d3ee
   - Glassmorphism cards: background rgba + border + border-radius 12px + box-shadow
   - Gradient primary button with hover (scale+brightness) + active (scale down)
   - Smooth transitions on all interactive elements
   - Fade-in animation on list items
   - Proper empty state message
   - Mobile responsive (flex/grid, max-width container, padding on mobile)
   - Spinner for loading states (CSS @keyframes spin, border-top accent color)
"""

FRONTEND_PROMPT = """You are the Frontend Agent for VibeCode IDE.
Build a complete static web app (no backend).

Output ONLY JSON (no markdown fences):
{
  "actions": [
    {"action":"add_file","file":"{project}/index.html","content":"COMPLETE HTML"},
    {"action":"add_file","file":"{project}/style.css","content":"COMPLETE CSS"},
    {"action":"add_file","file":"{project}/script.js","content":"COMPLETE JS"}
  ],
  "message": "Frontend: [description]"
}

RULES:
1. Pure client-side: all logic in JS, no backend calls needed
2. Modern dark UI: --bg:#0f172a, --surface:#1e293b, --primary:#7c3aed, --accent:#22d3ee
3. Inter font from Google Fonts
4. CSS variables in :root
5. Smooth transitions, hover effects, mobile responsive
6. localStorage for persistence if needed
"""

CODER_PROMPT = """You are the Code Agent for VibeCode IDE.
Write Python scripts or make targeted code edits.

Output ONLY JSON (no markdown fences):
{
  "actions": [
    {"action":"add_file",    "file":"project/main.py",  "content":"COMPLETE CODE"},
    {"action":"replace_file","file":"project/utils.py", "content":"COMPLETE CODE"},
    {"action":"patch_file",  "file":"project/config.py","search":"old text","replace":"new text"}
  ],
  "message": "Done: [description]"
}

RULES:
1. All code complete and runnable — no stubs or TODOs
2. if __name__ == '__main__' guard on every script entry point
3. patch_file for small changes; replace_file when >30% changes
"""

TERMINAL_PROMPT = """You are the Terminal Agent for VibeCode IDE.
Determine shell commands to install and run this project.

Output ONLY JSON (no markdown fences):
{
  "commands": [
    {
      "id": "install",
      "icon": "📦",
      "description": "Install Python dependencies",
      "command": "pip install -r requirements.txt",
      "cwd": "projectname",
      "required": true,
      "is_server": false,
      "auto_run": true
    },
    {
      "id": "run",
      "icon": "🚀",
      "description": "Start server → http://localhost:8000",
      "command": "uvicorn main:app --reload",
      "cwd": "projectname",
      "required": false,
      "is_server": true,
      "auto_run": false
    }
  ],
  "kill_active": false,
  "message": "Setup commands ready"
}

RULES:
- cwd = project folder name (relative to vibecode_projects/)
- Only safe commands: pip, python, npm, node, uvicorn, pytest, rm, rmdir, mkdir, del, rd
- is_server: true for long-running servers
- auto_run: true if the command should execute immediately. 
  * ALWAYS set to true for 'pip install', 'npm install', or any setup commands.
  * ALWAYS set to true for 'mkdir', 'rm', 'del' etc. if explicitly requested by the user.
  * ALWAYS set to true for the final 'run' command (e.g. python main.py or uvicorn) so the user sees the app start in real-time.
- If the user asked for a specific action (like "create folder"), emit the shell command for it even if it seems redundant for the code state.
- kill_active: true if the process should be restarted or if ports need clearing.
- For FastAPI apps use: uvicorn main:app --reload
- For Flask apps use: python main.py
- requirements.txt is always at project root — always use pip install -r requirements.txt
"""


# ─── Core Groq Call ───────────────────────────────────────────────────────────

def _groq_call(
    system: str, user: str, model: str, max_tokens: int
) -> tuple[dict, dict]:
    t0 = time.perf_counter()
    try:
        comp = _groq.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user",   "content": user},
            ],
            max_tokens=max_tokens,
            temperature=0.2,
            response_format={"type": "json_object"},
        )
        elapsed = int((time.perf_counter() - t0) * 1000)
        raw = comp.choices[0].message.content or "{}"
        usage = {
            "input_tokens":  comp.usage.prompt_tokens     if comp.usage else 0,
            "output_tokens": comp.usage.completion_tokens if comp.usage else 0,
            "total_tokens":  comp.usage.total_tokens      if comp.usage else 0,
            "elapsed_ms": elapsed,
        }
        try:
            result = json.loads(raw)
        except json.JSONDecodeError:
            result = _repair_json(raw) or {}
        return result, usage
    except Exception as e:
        elapsed = int((time.perf_counter() - t0) * 1000)
        log.error(f"Groq agent call failed ({model}): {e}")
        return {}, {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0, "elapsed_ms": elapsed}


def _repair_json(raw: str) -> Optional[dict]:
    """Recover the most complete partial JSON by scanning closing braces."""
    best: dict = {}
    best_n = -1
    for m in re.finditer(r'\}', raw):
        candidate = raw[:m.end()].rstrip().rstrip(',') + '\n  ]\n}'
        try:
            p = json.loads(candidate)
            if isinstance(p, dict):
                n = len(p.get("actions", p.get("commands", p.get("tasks", []))))
                if n > best_n:
                    best_n, best = n, p
        except json.JSONDecodeError:
            continue
    return best if best_n >= 0 else None


def _file_summary(files: Dict[str, str], project_name: Optional[str]) -> str:
    paths = sorted(files.keys())
    if project_name:
        paths = [p for p in paths if p.startswith(project_name + "/")]
    if not paths:
        return "(no existing files)"
    return "\n".join(f"  {p}" for p in paths[:30])


def _accumulate(
    log_dict: dict, agent_name: str,
    user_preview: str, output: dict, usage: dict
) -> None:
    log_dict["agents"].append({
        "name": agent_name,
        "input_preview": user_preview[:400],
        "output": output,
        "usage": usage,
    })
    t = log_dict["total_tokens"]
    t["input"]      += usage.get("input_tokens", 0)
    t["output"]     += usage.get("output_tokens", 0)
    t["total"]      += usage.get("total_tokens", 0)
    t["elapsed_ms"] += usage.get("elapsed_ms", 0)


# ─── Main Pipeline ────────────────────────────────────────────────────────────

async def run_agent_pipeline(
    user_message: str,
    files: Dict[str, str],
    project_name: Optional[str],
    model_id: str,
    projects_dir: Path,
) -> AsyncGenerator[dict, None]:

    session_ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    agent_log: dict = {
        "session":       session_ts,
        "timestamp":     datetime.now().isoformat(),
        "user_message":  user_message,
        "project":       project_name,
        "model":         model_id,
        "agents":        [],
        "total_tokens":  {"input": 0, "output": 0, "total": 0, "elapsed_ms": 0},
    }
    all_actions: List[dict] = []
    commands:    List[dict] = []

    # ── Step 1: Orchestrator (fast, cheap) ────────────────────────────────────
    yield {"event": "agent_start", "agent": "orchestrator",
           "message": "Analysing request…"}

    orch_user = (
        f"User request: {user_message}\n\n"
        f"Project folder: {project_name or 'new project'}\n"
        f"Existing files:\n{_file_summary(files, project_name)}"
    )
    plan, orch_usage = await asyncio.to_thread(
        _groq_call, ORCHESTRATOR_PROMPT, orch_user, FAST_MODEL, 512
    )
    _accumulate(agent_log, "orchestrator", orch_user, plan, orch_usage)
    yield {"event": "agent_done", "agent": "orchestrator",
           "plan": plan, "usage": orch_usage}

    project_type = plan.get("project_type", "full_stack")

    # ── Step 2: Build ─────────────────────────────────────────────────────────
    # Existing project file context (for edits)
    proj_files = {
        k: v for k, v in files.items()
        if project_name and k.startswith(project_name + "/")
    }
    ctx_blocks = "\n\n".join(
        f"=== {k} ===\n{v[:800]}"
        for k, v in list(proj_files.items())[:6]
    )
    existing_ctx = f"\n\nExisting files:\n{ctx_blocks}" if ctx_blocks else ""

    result = {}
    if project_type == "chat":
        # Skip coding agents
        result = {"message": plan.get("message", "How can I help?")}
    elif project_type in ("full_stack", "api_only"):
        # ── Single FullStack agent — generates everything in one shot ──────
        yield {"event": "agent_start", "agent": "fullstack",
               "message": "Building backend + frontend together…"}

        fs_prompt = FULLSTACK_PROMPT.replace("{project}", project_name or "project")
        fs_user = (
            f"USER REQUEST: {user_message}\n"
            f"Project folder name: {project_name}\n"
            f"Build a working full-stack app matching the request."
            + existing_ctx
        )
        result, usage = await asyncio.to_thread(
            _groq_call, fs_prompt, fs_user, model_id, 16384
        )
        actions = result.get("actions", [])
        all_actions.extend(actions)
        _accumulate(agent_log, "fullstack", fs_user[:600], result, usage)
        yield {"event": "agent_done", "agent": "fullstack",
               "actions": actions, "usage": usage,
               "message": result.get("message", "Full-stack build complete")}

    elif project_type == "web_only":
        # ── Frontend only ─────────────────────────────────────────────────
        yield {"event": "agent_start", "agent": "frontend",
               "message": "Building frontend…"}

        fe_prompt = FRONTEND_PROMPT.replace("{project}", project_name or "project")
        fe_user = (
            f"USER REQUEST: {user_message}\n"
            f"Project folder name: {project_name}"
            + existing_ctx
        )
        result, usage = await asyncio.to_thread(
            _groq_call, fe_prompt, fe_user, model_id, 12288
        )
        actions = result.get("actions", [])
        all_actions.extend(actions)
        _accumulate(agent_log, "frontend", fe_user[:600], result, usage)
        yield {"event": "agent_done", "agent": "frontend",
               "actions": actions, "usage": usage,
               "message": result.get("message", "")}

    else:
        # ── Coder (python scripts / edits) ────────────────────────────────
        yield {"event": "agent_start", "agent": "coder",
               "message": "Writing code…"}

        co_user = (
            f"USER REQUEST: {user_message}\n"
            f"Project folder: {project_name}"
            + existing_ctx
        )
        result, usage = await asyncio.to_thread(
            _groq_call, CODER_PROMPT, co_user, model_id, 8192
        )
        actions = result.get("actions", [])
        all_actions.extend(actions)
        _accumulate(agent_log, "coder", co_user[:600], result, usage)
        yield {"event": "agent_done", "agent": "coder",
               "actions": actions, "usage": usage,
               "message": result.get("message", "")}

    # ── Step 3: Terminal ──────────────────────────────────────────────────────
    terminal_needed = plan.get("terminal_needed", False)
    
    # Also trigger if python files were added to a new project
    if not terminal_needed:
        has_python = any(
            a.get("file", "").endswith(".py")
            for a in all_actions if a.get("action") in ("add_file", "replace_file")
        )
        if has_python and project_type != "edit":
            terminal_needed = True

    if terminal_needed:
        yield {"event": "agent_start", "agent": "terminal",
               "message": "Planning setup commands…"}

        # Find entry point
        created = [
            a.get("file", "") for a in all_actions
            if a.get("action") in ("add_file", "replace_file")
        ]
        
        # If no new files, look at existing proj_files
        py_files = [f for f in created if f.endswith(".py")]
        if not py_files:
            py_files = [f for f in proj_files.keys() if f.endswith(".py")]
            
        main_py = next((f for f in py_files if "main.py" in f), py_files[0] if py_files else "")
        main_rel = (
            main_py[len(project_name)+1:]
            if project_name and main_py.startswith(project_name + "/")
            else main_py
        )
        
        term_user = (
            f"User request: {user_message}\n"
            f"Project: {project_name}\n"
            f"Files (first 50): {json.dumps((created + list(proj_files.keys()))[:50])}\n"
            f"Entry point (relative to project folder): {main_rel}\n"
            f"Type: {project_type}"
        )
        term_result, term_usage = await asyncio.to_thread(
            _groq_call, TERMINAL_PROMPT, term_user, FAST_MODEL, 1024
        )
        commands = term_result.get("commands", [])
        # Make CWDs absolute for reliable shell execution
        for c in commands:
            c_cwd = c.get("cwd") or project_name
            c["cwd"] = str((projects_dir / c_cwd).absolute()) if c_cwd else str(projects_dir.absolute())
            
        kill_active = term_result.get("kill_active", False)
        
        if kill_active:
            yield {"event": "agent_shell_kill"}

        _accumulate(agent_log, "terminal", term_user, term_result, term_usage)
        yield {"event": "agent_done", "agent": "terminal",
               "commands": commands, "usage": term_usage,
               "message": term_result.get("message", "Commands ready")}
        
        # Trigger auto-runs
        for cmd in commands:
            if cmd.get("auto_run"):
                yield {"event": "agent_shell_cmd", "command": cmd["command"], "cwd": cmd["cwd"]}

    # ── Step 4: Save log ──────────────────────────────────────────────────────
    log_file_rel: Optional[str] = None
    if project_name:
        try:
            log_dir = projects_dir / project_name / ".agent_logs"
            log_dir.mkdir(parents=True, exist_ok=True)
            log_path = log_dir / f"{session_ts}.json"
            with open(log_path, "w", encoding="utf-8") as f:
                json.dump(agent_log, f, indent=2, ensure_ascii=False)
            log_file_rel = f"{project_name}/.agent_logs/{session_ts}.json"
        except Exception as e:
            log.warning(f"Could not save agent log: {e}")

    # ── Final event ───────────────────────────────────────────────────────────
    yield {
        "event":          "pipeline_done",
        "actions":        all_actions,
        "commands":       commands,
        "plan":           plan,
        "review":         {},
        "total_tokens":   agent_log["total_tokens"],
        "agent_log_file": log_file_rel,
        "message":        plan.get("message", "Build complete."),
    }
