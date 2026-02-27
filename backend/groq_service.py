import os, json, re, logging
from groq import Groq
from dotenv import load_dotenv
from typing import List, Dict, Optional

log = logging.getLogger("vibecode")

load_dotenv()
client = Groq(api_key=os.getenv("GROQ_API_KEY"))

# ──────────────────────────────────────────────────────────────
# Model Registry  (code-capable models only)
# max_tokens = max COMPLETION tokens the model supports on Groq
# ──────────────────────────────────────────────────────────────
MODEL_CONFIGS: Dict[str, dict] = {
    "llama-3.3-70b-versatile": {
        "display": "Llama 3.3 70B",
        "max_tokens": 32768,
        "description": "Best quality — complex full-stack projects",
        "recommended": True,
    },
    "qwen/qwen3-32b": {
        "display": "Qwen3 32B",
        "max_tokens": 32768,
        "description": "Excellent coder — strong logic & clean output",
    },
    "moonshotai/kimi-k2-instruct": {
        "display": "Kimi K2",
        "max_tokens": 16384,
        "description": "Creative reasoning — great for UI ideas",
    },
    "moonshotai/kimi-k2-instruct-0905": {
        "display": "Kimi K2 (0905)",
        "max_tokens": 16384,
        "description": "Pinned Kimi K2 release",
    },
    "meta-llama/llama-4-maverick-17b-128e-instruct": {
        "display": "Llama 4 Maverick 17B",
        "max_tokens": 8192,
        "description": "Fast & modern — good for quick builds",
    },
    "meta-llama/llama-4-scout-17b-16e-instruct": {
        "display": "Llama 4 Scout 17B",
        "max_tokens": 8192,
        "description": "Fast, large context — many files at once",
    },
    "openai/gpt-oss-120b": {
        "display": "GPT OSS 120B",
        "max_tokens": 8192,
        "description": "Largest GPT model — detailed outputs",
    },
    "openai/gpt-oss-20b": {
        "display": "GPT OSS 20B",
        "max_tokens": 8192,
        "description": "Balanced speed & quality",
    },
    "llama-3.1-8b-instant": {
        "display": "Llama 3.1 8B",
        "max_tokens": 8192,
        "description": "Fastest — great for quick edits",
    },
    "groq/compound": {
        "display": "Compound",
        "max_tokens": 8192,
        "description": "Groq compound routing model",
    },
    "groq/compound-mini": {
        "display": "Compound Mini",
        "max_tokens": 8192,
        "description": "Groq compound mini routing",
    },
}

DEFAULT_MODEL = "llama-3.3-70b-versatile"

# ──────────────────────────────────────────────────────────────
# System Prompt — Full-Stack + Web + Python
# ──────────────────────────────────────────────────────────────
SYSTEM_PROMPT = """You are VibeCode AI — an elite full-stack software engineer.
You build complete, production-ready applications: web frontends, Python backends, full-stack apps.
You NEVER produce stubs, placeholders, or TODOs. Every file you write must be immediately runnable.

## ABSOLUTE RULES
1. "actions" MUST contain complete, real file content — never empty, never stubbed.
2. "message" = one short sentence only. ALL code goes in "actions".
3. ZERO placeholder text. Every function fully implemented, every variable real.
4. Forward slashes in all file paths.
5. patch_file for small targeted edits; replace_file for big changes; add_file for new files.
6. Respect the project type — don't mix web-only with Python-only unless building a full-stack app.

## RESPONSE FORMAT (strict JSON, no markdown fences, no code blocks wrapping the JSON)
{
  "actions": [
    { "action": "add_file",     "file": "folder/backend/main.py", "content": "..." },
    { "action": "replace_file", "file": "folder/style.css",       "content": "..." },
    { "action": "patch_file",   "file": "folder/script.js",       "search": "exact old text", "replace": "new text" },
    { "action": "delete_file",  "file": "folder/old.html" }
  ],
  "message": "One sentence describing what was built.",
  "setup_instructions": {
      
      
    "install": ["pip install -r requirements.txt"],
    "run": ["cd folder", "python backend/main.py"],
    "env_template": "SECRET_KEY=changeme\nDB_URL=sqlite:///app.db\nPORT=8000",
    "visit": "http://localhost:8000",
    "notes": "The frontend is served automatically from FastAPI static files."
  }
}
Note: setup_instructions is ONLY included for full-stack or backend projects. Omit for web-only or Python scripts.

## ── PROJECT TYPE DETECTION ───────────────────────────────────────────────
Analyse the user request and context to classify the project type:

FULL_STACK  → User wants a complete web app WITH a backend/API/database. Build FastAPI backend + HTML/CSS/JS frontend.
              Signals: "full stack", "with backend", "with database", "rest api", "fastapi", "flask", "django",
                       "login", "auth", "user accounts", "store data", "crud", "api endpoint", "backend"

WEB_ONLY    → Frontend only — HTML, CSS, JavaScript. No backend needed.
              Signals: "website", "landing page", "portfolio", "web app" (without backend signals), "animation"

PYTHON      → Python script, CLI tool, data analysis, automation. No web frontend.
              Signals: "python script", "cli", "data analysis", "pandas", "numpy", "automation",
                       "scraper", "bot", "machine learning", "tkinter", "pygame"

API_ONLY    → Backend API without a frontend.
              Signals: "rest api", "api server", "json api", "build an api" (without frontend signals)


## ── FULL-STACK PROJECTS (FastAPI + HTML/CSS/JS) ───────────────────────────

### STRUCTURE RULE — FOLLOW USER INSTRUCTIONS EXACTLY:
If the user specifies a structure, use it. Examples:
- "main.py at root, templates/, static/"   → {folder}/main.py + {folder}/templates/ + {folder}/static/
- "Jinja2Templates"                         → use Jinja2Templates(directory="templates"), app.mount("/static", StaticFiles(directory="static"))
- No instructions given                     → use default structure below

### Default File Structure (when user doesn't specify):
{folder}/
  backend/
    main.py          ← FastAPI entry point, mounts frontend, defines all routes
    models.py        ← Pydantic request/response models
    database.py      ← SQLAlchemy setup (only if DB needed)
  frontend/
    index.html       ← Main HTML, uses relative fetch('/api/...')
    style.css        ← Modern responsive styles
    script.js        ← Frontend JS, all API calls to relative /api paths
  requirements.txt   ← All pip packages (fastapi, uvicorn, sqlalchemy, etc.)

### Backend Rules (backend/main.py):
```python
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
import uvicorn, os
from pathlib import Path

app = FastAPI(title="AppName")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"

# ── All API routes FIRST, before static mount ──
@app.get("/api/items")
async def get_items(): ...

# ── Serve frontend LAST ──
@app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")

if __name__ == "__main__":
    print("🚀 Server: http://localhost:8000")
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
```

- ALWAYS define API routes BEFORE mounting StaticFiles (routes defined after mount are shadowed)
- NEVER use relative imports (from .models import ...) — always use plain imports (from models import ...)
- ALWAYS use uvicorn.run("main:app", ...) not "backend.main:app" — the script is run from its own directory
- ALWAYS use port 8000 for generated project backends — never use any other port
- Always use SQLite for databases unless user specifies otherwise
- Always include proper error handling with HTTPException
- Pydantic models for all request bodies
- Always use `Path(__file__).parent` for reliable relative paths

### Frontend Rules (frontend/index.html + style.css + script.js):
- API calls: `fetch('/api/...')` — RELATIVE paths, never hardcode http://localhost:8000
- Handle loading states and errors in JS
- Modern responsive design matching the jellyfish dark theme
- Clean, minimal UI appropriate for the app type
- Include a nav bar, main content area, appropriate forms/tables/lists

### requirements.txt for full-stack:
fastapi
uvicorn[standard]
sqlalchemy
python-dotenv
(add others as needed: passlib, python-jose for auth; aiofiles for file uploads etc.)

### setup_instructions for full-stack/backend:
ALWAYS return setup_instructions. Example:
{
  "install": ["pip install -r requirements.txt"],
  "run": ["cd {folder}", "python backend/main.py"],
  "env_template": "SECRET_KEY=changeme-use-a-long-random-string\nDB_URL=sqlite:///app.db",
  "visit": "http://localhost:8000",
  "notes": "Frontend served automatically. Create .env from .env.example before starting."
}


## ── WEB-ONLY PROJECTS (HTML / CSS / JS) ───────────────────────────────────

Every HTML file MUST have in <head>:
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=Poppins:wght@600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="style.css">
Every HTML file MUST have before </body>: <script src="script.js"></script>

Required sections:
1. <nav> sticky + logo + links + CTA button + hamburger
2. <section class="hero"> full viewport, gradient bg, clamp() headline, 2 CTA buttons, glow
3. <section class="features"> grid of 6 cards (emoji icon + h3 + p with REAL content)
4. <section class="about"> 2-col layout + stats with real numbers
5. Domain-specific section (pricing / menu / gallery / testimonials / products)
6. <section class="contact"> form with name/email/message + submit
7. <footer> logo + links + copyright

CSS Rules:
- :root with tokens: --primary, --primary-dark, --accent, --bg:#070710, --surface:#0e0e1c,
  --surface2:#16162a, --border:rgba(255,255,255,0.07), --text:#f0f0ff, --muted:#8888aa, --radius:16px
- nav: sticky + backdrop-filter:blur(20px) + rgba background
- glassmorphism cards: backdrop-filter:blur(12px) + transparent bg
- gradient buttons: border-radius:50px + hover translateY(-2px)
- Animations: fadeInUp, float, glow @keyframes
- Responsive: 480px, 768px, 1024px breakpoints

JS Features:
- Hamburger menu toggle
- IntersectionObserver scroll animations (fadeInUp)
- Smooth scroll for nav links
- Navbar shrink on scroll
- Form validation + success toast
- Domain-specific features (counters, sliders, filters, etc.)


## ── PYTHON SCRIPTS / CLI / DATA TOOLS ────────────────────────────────────

- Write complete, immediately runnable Python code
- if __name__ == '__main__': guard always required
- Use print() generously to show meaningful output
- Handle errors with try/except
- requirements.txt only when external packages are needed
- No setup_instructions for pure Python scripts — just show "python main.py" in message
- Realistic sample data — never stub functions


## ── FILE-SPECIFIC EDITS ───────────────────────────────────────────────────

When context shows a specific file is being discussed:
- Use patch_file for small, targeted changes (edit a function, change a style, fix a bug)
- Use replace_file only when 30%+ of the file changes
- Preserve all other code exactly as-is
- Explain the change in "message"
- NEVER re-create the entire project for a small edit request


## MEMORY & CONTEXT
- Use conversation history to remember past decisions, colors, project names, and preferences
- When improving existing files, read the current content from context and build on it
- Maintain consistency in naming, colors, and architecture across the entire project
- If the user says "add X" or "fix Y", only change what's needed — don't rebuild everything
"""


def build_context(
    user_message: str,
    files: Dict[str, str],
    current_file: str,
    project_name: Optional[str]
) -> str:
    """
    Build smart context:
    - Project summary at top with all file paths
    - Active file always in full
    - Related project files in full (up to budget)
    - Other files as path-only stubs
    """
    parts = []

    # 1. Project summary (limit paths to save tokens)
    p_paths = sorted(files.keys())
    if len(p_paths) > 60:
        summary_paths = "\n".join(f"  {k}" for k in p_paths[:60]) + f"\n  ... and {len(p_paths)-60} more files"
    else:
        summary_paths = "\n".join(f"  {k}" for k in p_paths)

    if project_name:
        project_files = [k for k in files if k.startswith(project_name + '/') or k == project_name]
        parts.append(
            f"=== PROJECT: {project_name} ===\n"
            f"Files in project: {len(project_files)}\n"
            f"All file paths:\n{summary_paths}"
        )
    else:
        parts.append(f"=== ALL FILES ===\n{summary_paths}")

    # 2. Active file (always full)
    if current_file and current_file in files:
        content = files[current_file]
        parts.append(
            f"=== ACTIVE FILE: {current_file} ===\n{content}"
            if content else
            f"=== ACTIVE FILE: {current_file} (empty) ==="
        )

    # 3. Related files (same project folder, full content up to budget)
    BUDGET = 10_000  # chars — drastically lowered to fit 6k/8k TPM limits on Groq
    used   = sum(len(p) for p in parts)
    
    # Priority 1: Files in the active folder
    active_folder = (
        current_file.rsplit('/', 1)[0]
        if current_file and '/' in current_file else ''
    )
    proj_folder = project_name or active_folder

    file_count = 0
    for path, content in sorted(files.items()):
        if path == current_file:
            continue
        if file_count >= 15: # Never send more than 15 files to keep TPM low
            break
            
        in_project = proj_folder and path.startswith(proj_folder + '/')
        is_tiny    = len(content) < 300

        if (in_project or is_tiny) and content and used + len(content) < BUDGET:
            block = f"=== FILE: {path} ===\n{content}"
            parts.append(block)
            used += len(block)
            file_count += 1

    return "\n\n".join(parts)


def build_history_block(history: List[Dict[str, str]], max_messages: int = 20) -> str:
    """
    Format conversation history for the prompt.
    Sends last `max_messages` entries.
    """
    if not history:
        return ""
    recent = history[-max_messages:]
    lines  = []
    for msg in recent:
        role    = "User" if msg.get("role") == "user" else "Assistant"
        content = msg.get("content", "")[:1000]
        lines.append(f"{role}: {content}")
    return "\n".join(lines)


async def get_ai_response(
    user_message: str,
    files: Dict[str, str],
    current_file: Optional[str] = None,
    history: Optional[List[Dict[str, str]]] = None,
    project_name: Optional[str] = None,
    model: Optional[str] = None
) -> Dict:

    # Resolve model and its safe max_tokens
    model_id   = model if model and model in MODEL_CONFIGS else DEFAULT_MODEL
    max_tokens = MODEL_CONFIGS[model_id]["max_tokens"]

    context      = build_context(user_message, files, current_file or '', project_name)
    history_text = build_history_block(history or [])

    # Build the user turn
    prompt_parts = [f"Request: {user_message}"]
    if project_name:
        prompt_parts.append(f"Active project: {project_name}")
    if current_file:
        prompt_parts.append(f"Active file (being discussed): {current_file}")
    if history_text:
        prompt_parts.append(f"--- Conversation History (most recent last) ---\n{history_text}\n---")
    prompt_parts.append(f"Project context:\n{context}")
    prompt_parts.append(
        "Analyse the request type (FULL_STACK / WEB_ONLY / PYTHON / API_ONLY / EDIT) "
        "then write the complete code. Return JSON with a non-empty actions array. "
        "Include setup_instructions only for full-stack or backend projects."
    )

    prompt = "\n\n".join(prompt_parts)

    # Structured history (light — prevent doubling context)
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    if history:
        for msg in history[-4:]:
            role = msg.get("role", "user")
            if role in ("user", "assistant"):
                messages.append({"role": role, "content": msg.get("content", "")[:500]})

    messages.append({"role": "user", "content": prompt})

    try:
        completion = client.chat.completions.create(
            model=model_id,
            messages=messages,
            max_tokens=max_tokens,
            temperature=0.2,
            response_format={"type": "json_object"},
        )
    except Exception as e:
        err_str = str(e)
        if "context_length_exceeded" in err_str or "maximum context length" in err_str.lower():
            raise ValueError(f"CONTEXT_LIMIT_EXCEEDED:{model_id}:{err_str}")
        raise

    choice      = completion.choices[0]
    raw_content = choice.message.content or ""
    finish      = choice.finish_reason  # "stop" | "length" | "tool_calls" | None

    # ── Detect clear token-limit truncation ───────────────────
    if finish == "length":
        raise ValueError(
            f"CONTEXT_LIMIT_EXCEEDED:{model_id}:"
            "Model stopped at token limit (finish_reason=length). "
            "Switch to a model with higher max_tokens or simplify the request."
        )

    # ── Parse JSON with fallback repair ──────────────────────
    result = _parse_or_repair(raw_content, model_id, finish)

    result["_model"] = model_id

    if not result.get("actions"):
        result["actions"] = []
        result.setdefault("message", "No code was generated — please rephrase your request.")

    return result


def _parse_or_repair(raw: str, model_id: str, finish: str) -> dict:
    """
    Try to parse the AI response as JSON.
    If it fails (e.g. truncated content string), attempt to recover
    any fully-written action objects before the truncation point.
    """
    # Fast path — valid JSON
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass

    # ── Repair: find every closing brace that could end an action object,
    #    try capping there and closing the outer array + root object.
    #    Return the parse that yields the most complete actions.
    best: dict = {}
    best_count = -1

    for m in re.finditer(r'\}', raw):
        pos = m.end()
        candidate = raw[:pos].rstrip().rstrip(',') + '\n  ]\n}'
        try:
            parsed = json.loads(candidate)
            if isinstance(parsed, dict):
                n = len(parsed.get("actions", []))
                if n > best_count:
                    best_count = n
                    best = parsed
        except json.JSONDecodeError:
            continue

    if best_count >= 0:
        log.warning(
            f"Repaired truncated JSON from {model_id} "
            f"(finish={finish}): recovered {best_count} action(s)"
        )
        best.setdefault("message", f"⚠️ Response was partially truncated by {model_id} — {best_count} action(s) recovered.")
        return best

    # Nothing recoverable — surface as a limit error so the frontend
    # marks this model and prompts the user to switch.
    snippet = raw[:200].replace("\n", "\\n")
    log.error(f"Unrecoverable JSON from {model_id} (finish={finish}). Raw: {snippet!r}")
    raise ValueError(
        f"CONTEXT_LIMIT_EXCEEDED:{model_id}:"
        f"Model produced unrecoverable JSON (finish={finish}). "
        "Try a larger model such as Llama 3.3 70B."
    )
