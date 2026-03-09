import os, json, re, logging, asyncio, time
from typing import Dict, List, Optional, AsyncGenerator, Any
from datetime import datetime
from pathlib import Path
from groq import Groq
from dotenv import load_dotenv

from typing_extensions import Annotated, TypedDict
import operator
from langgraph.graph import StateGraph, START, END
from langgraph.checkpoint.memory import MemorySaver
from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage, AIMessage
from langgraph.graph.message import add_messages

log = logging.getLogger("vibecode")
load_dotenv()
_groq = Groq(api_key=os.getenv("GROQ_API_KEY"))

FAST_MODEL  = "llama-3.1-8b-instant"
STRONG_MODEL = "llama-3.3-70b-versatile"

# ─── System Prompts ──────────────────────────────────────────────────────────

BASE_SYSTEM_PROMPT = """You are an expert AI software engineer working inside VibeCode IDE.

SANDBOX RULES (CRITICAL — follow every time you output file paths or commands):
- Your working directory is already INSIDE the project folder `{project_name}/`.
- NEVER prepend `{project_name}/` to any path in code, commands, or file references.
- BAD:  `StaticFiles(directory="{project_name}/static")`
- GOOD: `StaticFiles(directory="static")`
- BAD:  `uvicorn {project_name}.main:app`
- GOOD: `uvicorn main:app --reload`
"""

# ─── Intent Agent ────────────────────────────────────────────────────────────

INTENT_PROMPT = """You are the Intent Classification Agent.
Analyze the user's message and output ONLY valid JSON.

RULES:
- If user says "stop", "kill", "terminate", "shutdown", "halt", "close server" → intent: "stop_server"
- If user says "run", "start", "launch", "execute", "test" → intent: "execution_only"
- If user asks a question, wants explanation, greetings → intent: "chat"
- If user wants to build, add features, fix bugs, create files → intent: "coding"
- is_new_project: true if no project exists yet or user says "create", "new", "build"
- requires_terminal: true if the task involves running server or installing packages

Output ONLY this JSON (no markdown, no explanation):
{
  "intent": "coding",
  "is_new_project": false,
  "requires_terminal": true,
  "summary": "One sentence describing what user wants"
}"""

# ─── Chat Agent ──────────────────────────────────────────────────────────────

CHAT_PROMPT = """You are a friendly AI coding assistant inside VibeCode IDE.
Answer the user's question directly and helpfully.
For greetings, introduce yourself briefly.
For technical questions, give clear concise answers.

Output ONLY this JSON (no markdown fences):
{
  "response": "Your answer here"
}"""

# ─── Planner Agent ───────────────────────────────────────────────────────────

PLANNER_PROMPT = """You are a Software Architecture Planner.
Create a minimal, working project plan based on the user's request.

ARCHITECTURE RULES:
1. FLAT STRUCTURE: Use flat file structure (no api/, utils/, models/ subfolders unless >10 files needed)
2. FastAPI projects ALWAYS need: main.py, templates/index.html, static/style.css, static/script.js, requirements.txt
3. Pure web projects need: index.html, style.css, script.js
4. NEVER use databases unless user explicitly asks for persistence — use Python lists/dicts in memory
5. Keep it minimal — only files actually needed

Output ONLY this JSON (no markdown, no explanation):
{
  "thinking": "Brief architecture decision",
  "project_type": "fastapi | web | python_script",
  "files": [
    {"path": "main.py", "purpose": "FastAPI app entry point"},
    {"path": "templates/index.html", "purpose": "Main UI template"},
    {"path": "static/style.css", "purpose": "Styles"},
    {"path": "static/script.js", "purpose": "Frontend logic"},
    {"path": "requirements.txt", "purpose": "Python dependencies"}
  ],
  "roadmap": [
    "Step 1: Create FastAPI backend with CRUD routes",
    "Step 2: Build responsive HTML UI",
    "Step 3: Write JavaScript for API calls"
  ],
  "run_command": "uvicorn main:app --reload --port 8000"
}"""

# ─── Coder Agent ─────────────────────────────────────────────────────────────

CODER_PROMPT = """You are an expert Full-Stack Code Generation Agent.
Generate COMPLETE, WORKING code for ALL files in the plan.

═══ CRITICAL FASTAPI RULES (MUST FOLLOW) ═══

1. DIRECTORY NAMES — ALWAYS USE BARE NAMES:
   ✓ CORRECT: Jinja2Templates(directory="templates")
   ✗ WRONG:   Jinja2Templates(directory="{project_name}/templates")
   ✓ CORRECT: StaticFiles(directory="static")
   ✗ WRONG:   StaticFiles(directory="{project_name}/static")

2. ROUTE ORDER — Routes BEFORE mounts:
   ✓ app.get("/")                          ← define route first
   ✓ app.mount("/static", StaticFiles...)  ← mount AFTER routes
   ✗ WRONG: mount first, then define routes

3. MANDATORY ROOT ROUTE — ALWAYS include:
   @app.get("/")
   async def root(request: Request):
       return templates.TemplateResponse("index.html", {{"request": request}})

4. API PREFIX — Backend routes use /api/ prefix:
   ✓ @app.get("/api/items")
   ✗ WRONG: @app.get("/items")

5. STATIC LINKS IN HTML — Use /static/ prefix:
   ✓ <link rel="stylesheet" href="/static/style.css">
   ✗ WRONG: <link rel="stylesheet" href="static/style.css">

6. FRONTEND FETCH — Always relative paths:
   ✓ fetch('/api/items')
   ✗ WRONG: fetch('http://localhost:8000/api/items')

7. IN-MEMORY STORAGE — Use Python lists/dicts (no SQLite unless asked):
   items = []  # Simple in-memory store
   @app.post("/api/items")
   async def add_item(item: ItemModel):
       items.append(item.dict())
       return item

8. PYTHON PATHS — Use Path(__file__).parent for file operations:
   BASE_DIR = Path(__file__).parent
   UPLOAD_DIR = BASE_DIR / "uploads"

9. requirements.txt MUST include:
   fastapi
   uvicorn[standard]
   jinja2
   python-multipart

═══ UI QUALITY RULES ═══

10. MODERN DARK UI:
    - Background: #0d1117 or #1a1a2e
    - Cards: #161b22 or #16213e
    - Accent: #2563eb (blue) or #8b5cf6 (purple)
    - Text: #e6edf3
    - Rounded corners: border-radius: 12px
    - Shadows: box-shadow: 0 4px 20px rgba(0,0,0,0.3)
    - Hover transitions: transition: all 0.2s ease
    - Font: system-ui, -apple-system, sans-serif

11. RESPONSIVE: Use CSS Grid or Flexbox. Works on mobile.

12. FUNCTIONAL BUTTONS: Every button must have working JavaScript.

═══ OUTPUT FORMAT ═══

Output ONLY this JSON (no markdown fences, no explanation):
{
  "actions": [
    {
      "action": "add_file",
      "file": "main.py",
      "content": "COMPLETE file content here — no placeholders, no TODOs"
    },
    {
      "action": "add_file",
      "file": "templates/index.html",
      "content": "Complete HTML"
    },
    {
      "action": "add_file",
      "file": "static/style.css",
      "content": "Complete CSS"
    },
    {
      "action": "add_file",
      "file": "static/script.js",
      "content": "Complete JavaScript"
    },
    {
      "action": "add_file",
      "file": "requirements.txt",
      "content": "fastapi\\nuvicorn[standard]\\njinja2\\npython-multipart"
    }
  ],
  "message": "Created a working [project description]."
}"""

# ─── Terminal Agent ───────────────────────────────────────────────────────────

TERMINAL_PROMPT = """You are the Terminal Command Agent.
Generate shell commands to set up and run the project.

RULES:
1. cwd will already be INSIDE `{project_name}/` — do NOT prepend project name
2. Install command: `pip install -r requirements.txt`
3. Run command: `uvicorn main:app --reload --port 8000` (for FastAPI)
4. Mark the main server command with `auto_run: true`
5. Install command has `auto_run: false` (user runs manually unless needed)

Output ONLY this JSON (no markdown, no explanation):
{
  "commands": [
    {
      "id": "install",
      "label": "Install Dependencies",
      "command": "pip install -r requirements.txt",
      "cwd": "ACTUAL_PROJECT_NAME",
      "icon": "📦",
      "description": "Install Python packages",
      "auto_run": false,
      "is_server": false
    },
    {
      "id": "run",
      "label": "Start Server",
      "command": "uvicorn main:app --reload --port 8000",
      "cwd": "ACTUAL_PROJECT_NAME",
      "icon": "🚀",
      "description": "Launch the web server at http://localhost:8000",
      "auto_run": true,
      "is_server": true
    }
  ]
}"""

# ─── Graph State ─────────────────────────────────────────────────────────────

class AgentState(TypedDict):
    user_message: str
    project_name: str
    files: Dict[str, str]
    projects_dir: Any
    model_id: str

    # Message history for true LangGraph memory
    messages: Annotated[List[BaseMessage], add_messages]

    intent_data: dict
    roadmap_data: dict

    actions: Annotated[List[dict], operator.add]
    commands: Annotated[List[dict], operator.add]
    events: Annotated[List[dict], operator.add]

    error_count: int
    chat_response: str

# ─── Helper Functions ────────────────────────────────────────────────────────

def _extract_json(text: str) -> dict:
    """Robustly extract JSON from LLM response, handling markdown fences and hallucinations."""
    try:
        text = text.strip()
        # Strip markdown fences
        if text.startswith("```json"):
            text = text[7:]
        elif text.startswith("```"):
            text = text[3:]
        if text.endswith("```"):
            text = text[:-3]
        text = text.strip()

        # Handle doubled braces hallucination {{...}}
        if text.startswith("{{") and text.endswith("}}"):
            text = text[1:-1].strip()

        # Find outermost JSON object
        start = text.find('{')
        end = text.rfind('}')
        if start != -1 and end != -1 and end > start:
            return json.loads(text[start:end+1])
        return {}
    except json.JSONDecodeError as e:
        # Try to fix truncated JSON by completing it
        log.warning(f"JSON parse error (trying repair): {e}")
        try:
            # Count open braces and close them
            snippet = text[start:] if 'start' in dir() else text
            open_b = snippet.count('{') - snippet.count('}')
            open_sq = snippet.count('[') - snippet.count(']')
            snippet += ']' * max(0, open_sq) + '}' * max(0, open_b)
            return json.loads(snippet)
        except Exception:
            log.error(f"JSON repair failed. Raw text[:500]: {text[:500]}")
            return {}
    except Exception as e:
        log.error(f"JSON extraction failed: {e}\nRaw text[:300]: {text[:300]}")
        return {}


def _call_llm(system: str, history: List[BaseMessage], model: str, max_tokens: int = 4096) -> tuple[dict, dict]:
    """Call Groq LLM with message history and return parsed JSON + usage stats."""
    messages = [{"role": "system", "content": system}]
    for m in history:
        if isinstance(m, HumanMessage):
            messages.append({"role": "user", "content": str(m.content)})
        elif isinstance(m, AIMessage):
            messages.append({"role": "assistant", "content": str(m.content)})

    t0 = time.time()
    completion = _groq.chat.completions.create(
        model=model,
        messages=messages,
        temperature=0.15,
        max_tokens=max_tokens,
    )
    elapsed_ms = round((time.time() - t0) * 1000)

    content = completion.choices[0].message.content or "{}"
    u = completion.usage
    prompt_tok = u.prompt_tokens if u else 0
    completion_tok = u.completion_tokens if u else 0
    usage = {
        "prompt_tokens": prompt_tok,
        "completion_tokens": completion_tok,
        "total_tokens": prompt_tok + completion_tok,
        "elapsed_ms": elapsed_ms,
    }
    return _extract_json(content), usage


def _get_context(state: AgentState) -> str:
    """Build a project context string from current files."""
    proj_files = {
        k: v for k, v in state["files"].items()
        if state["project_name"] and k.startswith(state["project_name"] + "/")
    }
    ctx_blocks = "\n\n".join(f"=== {k} ===\n{v[:2000]}" for k, v in list(proj_files.items())[:8])
    mode = "UPDATE/FEATURE" if proj_files else "NEW_PROJECT"
    return f"Project: {state['project_name'] or 'None'} (Mode: {mode})\n\nExisting files:\n{ctx_blocks}"


def _resolve_project_name(state: AgentState) -> str:
    """Get project name, defaulting to 'new_project'."""
    return state["project_name"] or "new_project"


# ─── LangGraph Nodes ─────────────────────────────────────────────────────────

def _kill_port(port: int = 8000) -> list:
    """Kill entire uvicorn process tree using taskkill /T (kills whole tree including reloader)."""
    import subprocess as _sp, sys as _sys
    killed = []
    try:
        if _sys.platform == "win32":
            # Find worker PID(s) on port
            r = _sp.run(
                ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
                 f"(Get-NetTCPConnection -LocalPort {port} -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique"],
                capture_output=True, text=True, timeout=10
            )
            worker_pids = [p.strip() for p in r.stdout.strip().splitlines() if p.strip().isdigit()]
            log.info(f"_kill_port found worker pids={worker_pids}")
            for wpid in worker_pids:
                # Get parent PID via CIM
                cim_r = _sp.run(
                    ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
                     f"(Get-CimInstance Win32_Process -Filter 'ProcessId={wpid}' -ErrorAction SilentlyContinue).ParentProcessId"],
                    capture_output=True, text=True, timeout=5
                )
                ppid = cim_r.stdout.strip()
                # Kill parent tree first (stops reloader from respawning worker)
                if ppid.isdigit() and ppid != "0":
                    _sp.run(["taskkill", "/F", "/T", "/PID", ppid], capture_output=True)
                    killed.append(ppid)
                # Kill worker tree
                _sp.run(["taskkill", "/F", "/T", "/PID", wpid], capture_output=True)
                killed.append(wpid)
            if not killed:
                killed.append(f"port:{port}")
        else:
            _sp.run(f"fuser -k {port}/tcp", shell=True, capture_output=True)
            killed.append(str(port))
    except Exception as e:
        log.warning(f"kill_port({port}) error: {e}")
    return killed


def node_stop(state: AgentState):
    """Stop the running server by killing port 8000 process tree."""
    killed = _kill_port(8000)

    msg = f"Server stopped. (killed PIDs: {', '.join(killed)})" if killed else "No server was running on port 8000."
    return {
        "chat_response": msg,
        "events": [
            {"event": "agent_start", "agent": "terminal", "message": "Stopping server..."},
            {"event": "agent_shell_kill"},
            {"event": "agent_done", "agent": "terminal", "output": {}, "commands": [], "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "elapsed_ms": 0}},
            {"event": "chat_text", "text": msg}
        ]
    }


_STOP_WORDS   = {"stop", "kill", "terminate", "shutdown", "halt", "close", "quit", "exit"}
_RUN_WORDS    = {"run", "start", "launch", "execute", "deploy", "serve"}
_SERVER_WORDS = {"server", "port", "uvicorn", "app", "process", "service"}
_BUILD_WORDS  = {"build", "create", "make", "add", "implement", "write", "generate", "fix", "update", "change", "modify", "refactor"}
_CHAT_WORDS   = {"what", "how", "why", "explain", "tell", "hello", "hi", "hey", "help", "?"}

def _keyword_intent(msg: str) -> Optional[str]:
    """Fast keyword-based intent detection — no LLM needed for clear commands."""
    words = set(re.sub(r"[^\w\s]", " ", msg.lower()).split())
    if words & _STOP_WORDS:
        return "stop_server"
    if words & _RUN_WORDS and not (words & _BUILD_WORDS):
        return "execution_only"
    return None   # unclear — let LLM decide


def node_intent(state: AgentState):
    """Classify user intent: chat | coding | execution_only | stop_server"""
    msg = state["user_message"]
    zero_usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "elapsed_ms": 0}

    # Fast path: keyword detection skips LLM for obvious commands
    fast_intent = _keyword_intent(msg)
    if fast_intent:
        res = {"intent": fast_intent, "is_new_project": False, "requires_terminal": True, "summary": msg[:80]}
        log.info(f"Intent (keyword): {fast_intent}")
        return {
            "intent_data": res,
            "events": [
                {"event": "agent_start", "agent": "intent", "message": "Analyzing your request..."},
                {"event": "agent_done", "agent": "intent", "plan": res, "usage": zero_usage}
            ]
        }

    # Slow path: LLM for complex/ambiguous messages
    pname = _resolve_project_name(state)
    sys_prompt = BASE_SYSTEM_PROMPT.format(project_name=pname) + "\n\n" + INTENT_PROMPT
    res, usage = _call_llm(sys_prompt, state["messages"], FAST_MODEL, max_tokens=512)

    log.info(f"Intent (LLM): {res.get('intent', '?')} | new={res.get('is_new_project')} | terminal={res.get('requires_terminal')}")

    return {
        "intent_data": res,
        "events": [
            {"event": "agent_start", "agent": "intent", "message": "Analyzing your request..."},
            {"event": "agent_done", "agent": "intent", "plan": res, "usage": usage}
        ]
    }


def node_chat(state: AgentState):
    """Handle conversational messages and questions."""
    pname = _resolve_project_name(state)
    sys_prompt = BASE_SYSTEM_PROMPT.format(project_name=pname) + "\n\n" + CHAT_PROMPT
    res, usage = _call_llm(sys_prompt, state["messages"], FAST_MODEL, max_tokens=1024)

    msg = res.get("response", "I'm here to help! What would you like to build?")

    return {
        "chat_response": msg,
        "messages": [AIMessage(content=msg)],
        "events": [
            {"event": "agent_start", "agent": "chat", "message": "Thinking..."},
            {"event": "agent_done", "agent": "chat", "output": res, "usage": usage},
            {"event": "chat_text", "text": msg}
        ]
    }


def node_planner(state: AgentState):
    """Create project architecture plan with file list and roadmap."""
    pname = _resolve_project_name(state)
    sys_prompt = BASE_SYSTEM_PROMPT.format(project_name=pname) + "\n\n" + PLANNER_PROMPT

    context_msg = HumanMessage(content=(
        f"User request: {state['user_message']}\n\n"
        f"{_get_context(state)}"
    ))

    res, usage = _call_llm(sys_prompt, state["messages"] + [context_msg], FAST_MODEL, max_tokens=2048)

    log.info(f"Plan: {res.get('project_type')} | files={len(res.get('files', []))} | steps={len(res.get('roadmap', []))}")

    return {
        "roadmap_data": res,
        "events": [
            {"event": "agent_start", "agent": "planning", "message": "Designing architecture..."},
            {"event": "agent_done", "agent": "planning", "plan": res, "usage": usage}
        ]
    }


def node_coder(state: AgentState):
    """Generate complete, working code for all project files."""
    pname = _resolve_project_name(state)
    sys_prompt = BASE_SYSTEM_PROMPT.format(project_name=pname) + "\n\n" + CODER_PROMPT

    plan = state.get("roadmap_data", {})
    files_to_create = plan.get("files", [])
    file_list_str = "\n".join(f"  - {f['path']}: {f.get('purpose', '')}" for f in files_to_create)

    context_msg = HumanMessage(content=(
        f"User request: {state['user_message']}\n\n"
        f"Architecture Plan:\n"
        f"Project type: {plan.get('project_type', 'fastapi')}\n"
        f"Files to generate:\n{file_list_str}\n\n"
        f"Roadmap:\n" + "\n".join(plan.get("roadmap", [])) + "\n\n"
        f"{_get_context(state)}\n\n"
        f"CRITICAL: Generate ALL {len(files_to_create)} files listed above. "
        f"Every file must be complete — no TODOs, no placeholders, no '...' ellipsis."
    ))

    res, usage = _call_llm(sys_prompt, state["messages"] + [context_msg], state["model_id"], max_tokens=16384)

    actions = res.get("actions", [])
    log.info(f"Coder: generated {len(actions)} file actions")

    msg_out = res.get("message", f"Generated {len(actions)} files.")

    return {
        "actions": actions,
        "messages": [AIMessage(content=msg_out)],
        "events": [
            {"event": "agent_start", "agent": "coding", "message": "Writing code..."},
            {"event": "agent_done", "agent": "coding", "output": res, "actions": actions, "usage": usage}
        ]
    }


def node_terminal(state: AgentState):
    """Generate setup and run commands for the project."""
    pname = _resolve_project_name(state)
    sys_prompt = BASE_SYSTEM_PROMPT.format(project_name=pname) + "\n\n" + TERMINAL_PROMPT

    plan = state.get("roadmap_data", {})
    run_cmd = plan.get("run_command", "uvicorn main:app --reload --port 8000")
    proj_type = plan.get("project_type", "fastapi")

    context_msg = HumanMessage(content=(
        f"Project name: {pname}\n"
        f"Project type: {proj_type}\n"
        f"Recommended run command: {run_cmd}\n"
        f"Files created: {[a.get('file') for a in state.get('actions', [])[:10]]}\n"
        f"Replace ACTUAL_PROJECT_NAME with: {pname}"
    ))

    res, usage = _call_llm(sys_prompt, [context_msg], FAST_MODEL, max_tokens=1024)
    cmds = res.get("commands", [])

    # Resolve cwd paths to absolute paths
    events = [{"event": "agent_start", "agent": "terminal", "message": "Preparing launch commands..."}]
    pdir = state["projects_dir"]

    for c in cmds:
        c_cwd = c.get("cwd") or pname
        if c_cwd in ("ACTUAL_PROJECT_NAME", "{project_name}", ""):
            c_cwd = pname
        c["cwd"] = str((pdir / c_cwd).absolute()) if c_cwd else str(pdir.absolute())

        # Auto-run commands with auto_run: true get sent to shell immediately
        if c.get("auto_run"):
            events.append({
                "event": "agent_shell_cmd",
                "command": c["command"],
                "cwd": c["cwd"],
                "label": c.get("label", "Run"),
                "icon": c.get("icon", "🚀")
            })

    events.append({
        "event": "agent_done",
        "agent": "terminal",
        "output": res,
        "commands": cmds,
        "usage": usage
    })

    return {"commands": cmds, "events": events}


# ─── Routing ─────────────────────────────────────────────────────────────────

def route_intent(state: AgentState) -> str:
    intent = state.get("intent_data", {}).get("intent", "").lower()
    if intent == "chat":
        return "chat"
    elif intent == "stop_server":
        return "stop"
    elif intent == "execution_only":
        return "terminal"
    else:
        return "planner"


def route_after_coder(state: AgentState) -> str:
    """Decide whether to run terminal after coder."""
    intent = state.get("intent_data", {}).get("requires_terminal", True)
    plan = state.get("roadmap_data", {})
    proj_type = plan.get("project_type", "fastapi")
    # Always run terminal for FastAPI projects; skip for pure web
    if proj_type == "web" and not intent:
        return "end"
    return "terminal"


# ─── Graph Compilation ───────────────────────────────────────────────────────

workflow = StateGraph(AgentState)
workflow.add_node("intent", node_intent)
workflow.add_node("chat", node_chat)
workflow.add_node("stop", node_stop)
workflow.add_node("planner", node_planner)
workflow.add_node("coder", node_coder)
workflow.add_node("terminal", node_terminal)

workflow.add_edge(START, "intent")
workflow.add_conditional_edges("intent", route_intent, {
    "chat":     "chat",
    "stop":     "stop",
    "terminal": "terminal",
    "planner":  "planner",
})
workflow.add_edge("chat", END)
workflow.add_edge("stop", END)
workflow.add_edge("planner", "coder")
workflow.add_conditional_edges("coder", route_after_coder, {
    "terminal": "terminal",
    "end":      END,
})
workflow.add_edge("terminal", END)

memory = MemorySaver()
agent_graph = workflow.compile(checkpointer=memory)

# ─── Entry Point ─────────────────────────────────────────────────────────────

async def run_agent_pipeline(
    user_message: str,
    files: Dict[str, str],
    project_name: Optional[str],
    model_id: str,
    projects_dir: Path,
) -> AsyncGenerator[dict, None]:

    initial_state = {
        "user_message": user_message,
        "project_name": project_name or "",
        "files": files,
        "projects_dir": projects_dir,
        "model_id": model_id,
        "messages": [HumanMessage(content=user_message)],
        "intent_data": {},
        "roadmap_data": {},
        "actions": [],
        "commands": [],
        "events": [],
        "error_count": 0,
        "chat_response": ""
    }

    # Thread ID for memory persistence (per project)
    thread_id = project_name if project_name else "global_session"
    config = {"configurable": {"thread_id": thread_id}}

    final_actions: List[dict] = []
    final_commands: List[dict] = []
    total_usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "elapsed_ms": 0}

    async for event in agent_graph.astream(initial_state, config=config):
        for node_name, state_update in event.items():
            if "actions" in state_update:
                final_actions.extend(state_update["actions"])
            if "commands" in state_update:
                final_commands.extend(state_update["commands"])
            if "events" in state_update:
                for e in state_update["events"]:
                    # Accumulate token usage
                    if e.get("event") == "agent_done" and "usage" in e:
                        u = e["usage"]
                        total_usage["prompt_tokens"]    += u.get("prompt_tokens", 0)
                        total_usage["completion_tokens"] += u.get("completion_tokens", 0)
                        total_usage["total_tokens"]     += u.get("total_tokens", 0)
                        total_usage["elapsed_ms"]       += u.get("elapsed_ms", 0)
                    yield e

    # Final event — frontend waits for this to apply files and show command buttons
    yield {
        "event": "pipeline_done",
        "actions": final_actions,
        "commands": final_commands,
        "total_tokens": total_usage,
        "review": {},
        "message": "Task complete. All files generated successfully."
    }
