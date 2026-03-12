from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, StreamingResponse
from schemas import ChatRequest, ChatResponse, RunRequest, PipRequest, CompleteRequest
from groq_service import get_ai_response, MODEL_CONFIGS, DEFAULT_MODEL
from agent_service import run_agent_pipeline
from pydantic import BaseModel
from typing import Optional
import uvicorn, os, json, shutil, subprocess, sys, asyncio, logging, time, traceback, requests, httpx
from pathlib import Path
from datetime import datetime

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

# ── Colored logger ────────────────────────────────────────────
class _ColorFormatter(logging.Formatter):
    RESET  = "\033[0m"
    BOLD   = "\033[1m"
    COLORS = {
        logging.DEBUG:    "\033[36m",   # cyan
        logging.INFO:     "\033[32m",   # green
        logging.WARNING:  "\033[33m",   # yellow
        logging.ERROR:    "\033[31m",   # red
        logging.CRITICAL: "\033[35m",   # magenta
    }
    LEVEL_ICONS = {
        logging.DEBUG:    ".",
        logging.INFO:     "*",
        logging.WARNING:  "!",
        logging.ERROR:    "x",
        logging.CRITICAL: "X",
    }

    def format(self, record):
        color = self.COLORS.get(record.levelno, self.RESET)
        icon  = self.LEVEL_ICONS.get(record.levelno, " ")
        ts    = datetime.now().strftime("%H:%M:%S")
        msg   = record.getMessage()
        if record.exc_info:
            msg += "\n" + "".join(traceback.format_exception(*record.exc_info)).rstrip()
        return f"{color}{icon} [{ts}] {msg}{self.RESET}"

def _make_logger(name: str) -> logging.Logger:
    lg = logging.getLogger(name)
    lg.setLevel(logging.DEBUG)
    if not lg.handlers:
        h = logging.StreamHandler(sys.stdout)
        h.setFormatter(_ColorFormatter())
        lg.addHandler(h)
    lg.propagate = False
    return lg

log = _make_logger("vibecode")

app = FastAPI(title="VibeCode IDE")

# ── Request / response timing middleware ─────────────────────
@app.middleware("http")
async def log_requests(request: Request, call_next):
    start = time.perf_counter()
    try:
        response = await call_next(request)
        ms = (time.perf_counter() - start) * 1000
        status = response.status_code
        color  = "\033[32m" if status < 400 else ("\033[33m" if status < 500 else "\033[31m")
        reset  = "\033[0m"
        log.info(f"{color}{request.method} {request.url.path}  {status}  {ms:.0f}ms{reset}")
        return response
    except Exception as exc:
        ms = (time.perf_counter() - start) * 1000
        log.error(f"{request.method} {request.url.path}  FAILED  {ms:.0f}ms  →  {exc}", exc_info=True)
        raise

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)

BASE_DIR      = Path(__file__).resolve().parent.parent
VIBECODE_DIR  = BASE_DIR / "vibecode"
PROJECTS_DIR  = BASE_DIR / "vibecode_projects"
HISTORY_DIR   = BASE_DIR / ".vc_history"   # hidden folder – never served

for d in (PROJECTS_DIR, HISTORY_DIR):
    d.mkdir(exist_ok=True)

# ── Static files ────────────────────────────────────────────
app.mount("/project", StaticFiles(directory=PROJECTS_DIR), name="project")

@app.get("/api/config")
async def get_config():
    """Returns IDE configuration including absolute project paths"""
    return {
        "projects_dir": str(PROJECTS_DIR),
        "os_sep": os.sep,
        "platform": sys.platform
    }

# ── Chat ─────────────────────────────────────────────────────
@app.post("/api/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    model   = request.model or "default"
    project = request.project_name or "—"
    n_files = len(request.files) if request.files else 0
    preview = (request.message or "")[:80].replace("\n", " ")
    log.info(f"AI Chat  model={model}  project={project}  files={n_files}  msg={preview!r}")
    try:
        t0 = time.perf_counter()
        response = await get_ai_response(
            request.message, request.files,
            request.current_file, request.history,
            request.project_name, request.model
        )
        elapsed = (time.perf_counter() - t0) * 1000
        actions = response.get("actions", [])
        log.info(f"AI done  {elapsed:.0f}ms  actions={len(actions)}  → {[a.get('action','?')+':'+a.get('file','') for a in actions[:6]]}")
        return response
    except ValueError as e:
        err = str(e)
        if err.startswith("CONTEXT_LIMIT_EXCEEDED:"):
            parts = err.split(":", 2)
            model_id = parts[1] if len(parts) > 1 else "unknown"
            log.warning(f"Context limit hit for model {model_id}")
            raise HTTPException(status_code=413, detail=f"CONTEXT_LIMIT:{model_id}")
        log.error(f"Chat ValueError: {err}")
        raise HTTPException(status_code=500, detail=err)
    except Exception as e:
        log.error(f"Chat error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

# ── Proxy Route (for sub-projects on Render) ───────────────
@app.api_route("/proxy/{port}/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"])
async def proxy_request(port: int, path: str, request: Request):
    """
    Proxies requests from the main IDE to a local server running inside the container.
    This allows viewing sub-projects (e.g. on port 8000) on Render's single-port architecture.
    """
    # Block obviously recursive attempts
    if port == int(os.environ.get("PORT", 8001)):
        raise HTTPException(400, "Cannot proxy to the IDE itself")
        
    target_url = f"http://localhost:{port}/{path}"
    query = request.url.query
    if query:
        target_url += f"?{query}"
        
    log.debug(f"Proxying {request.method} {request.url.path} -> {target_url}")
    
    async with httpx.AsyncClient() as client:
        # Prepare headers
        headers = dict(request.headers)
        headers.pop("host", None)
        headers.pop("content-length", None) # httpx recalculates this
        
        try:
            resp = await client.request(
                method=request.method,
                url=target_url,
                content=await request.body(),
                headers=headers,
                follow_redirects=True,
                timeout=30.0
            )

            # Extract content-type to handle it specially if needed
            ct = resp.headers.get("content-type", "application/octet-stream")

            # For HTML responses: rewrite absolute asset paths so they go through the proxy.
            # e.g. /static/style.css → /proxy/8000/static/style.css
            if "text/html" in ct:
                body = await resp.aread()
                html = body.decode("utf-8", errors="replace")
                base_tag = f'<base href="/proxy/{port}/">'
                # Inject <base> right after <head> (or at top if no <head>)
                if "<head>" in html:
                    html = html.replace("<head>", f"<head>{base_tag}", 1)
                elif "<HEAD>" in html:
                    html = html.replace("<HEAD>", f"<HEAD>{base_tag}", 1)
                else:
                    html = base_tag + html
                resp_headers = {k: v for k, v in resp.headers.items()
                                if k.lower() not in ("content-length", "transfer-encoding")}
                return StreamingResponse(
                    iter([html.encode("utf-8")]),
                    status_code=resp.status_code,
                    headers=resp_headers,
                    media_type="text/html"
                )

            return StreamingResponse(
                resp.aiter_bytes(),
                status_code=resp.status_code,
                headers=dict(resp.headers),
                media_type=ct
            )
        except Exception as e:
            msg = f"Proxy error to port {port}: {str(e)}"
            log.warning(msg)
            # Return a friendly HTML error page for preview frame
            err_html = f"""
            <html><body style="margin:0;padding:2rem;background:#0a0a0f;color:#ef4444;font-family:system-ui,sans-serif;">
            <div style="border:1px solid #ef4444;padding:1rem;border-radius:8px;background:rgba(239, 68, 68, 0.1);">
                <h2 style="margin-top:0;">🛑 Preview Proxy Error</h2>
                <p>Could not connect to the server on port <b>{port}</b>.</p>
                <p style="color:#a1a1aa;font-size:14px;">Make sure your project server is actually running and listening on 0.0.0.0 or localhost.</p>
                <pre style="background:#000;padding:1rem;border-radius:4px;overflow:auto;margin-top:1rem;color:#fecaca;">{e}</pre>
                <button onclick="location.reload()" style="background:#ef4444;color:white;border:none;padding:8px 16px;border-radius:4px;cursor:pointer;margin-top:8px;">Try Again</button>
            </div>
            </body></html>
            """
            return StreamingResponse(
                iter([err_html.encode()]),
                status_code=502,
                media_type="text/html"
            )

# ── Multi-Agent Chat (SSE streaming) ─────────────────────────
@app.post("/api/agent-chat")
async def agent_chat(request: ChatRequest):
    """Multi-agent pipeline: Orchestrator → Coder(s) → Terminal → Reviewer.
    Returns a text/event-stream of JSON events for real-time UI updates."""
    model = request.model or DEFAULT_MODEL
    project = request.project_name or "—"
    log.info(f"Agent pipeline  model={model}  project={project}")

    async def _stream():
        try:
            async for event in run_agent_pipeline(
                user_message=request.message,
                files=request.files or {},
                project_name=request.project_name,
                model_id=model,
                projects_dir=PROJECTS_DIR,
            ):
                yield f"data: {json.dumps(event)}\n\n"
        except Exception as e:
            log.error(f"Agent pipeline error: {e}", exc_info=True)
            yield f"data: {json.dumps({'event': 'error', 'message': str(e)})}\n\n"
        finally:
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        _stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Kill process on port ──────────────────────────────────────
class KillPortRequest(BaseModel):
    port: int = 8000

@app.post("/api/kill-port")
async def kill_port(req: KillPortRequest):
    """Kill entire uvicorn process tree on port using taskkill /T (kills whole tree)."""
    port = req.port
    killed_pids = []
    try:
        if sys.platform == "win32":
            # Step 1: find all PIDs listening on port
            find_script = (
                f"(Get-NetTCPConnection -LocalPort {port} -ErrorAction SilentlyContinue).OwningProcess | "
                f"Select-Object -Unique"
            )
            r = subprocess.run(
                ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", find_script],
                capture_output=True, text=True, timeout=10
            )
            worker_pids = [p.strip() for p in r.stdout.strip().splitlines() if p.strip().isdigit()]
            log.info(f"kill-port found worker pids={worker_pids}")

            for wpid in worker_pids:
                # Find parent via CIM
                cim_r = subprocess.run(
                    ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
                     f"(Get-CimInstance Win32_Process -Filter 'ProcessId={wpid}' -ErrorAction SilentlyContinue).ParentProcessId"],
                    capture_output=True, text=True, timeout=5
                )
                ppid = cim_r.stdout.strip()
                # Kill parent tree first (prevents reloader from respawning worker)
                if ppid.isdigit() and ppid != "0":
                    subprocess.run(["taskkill", "/F", "/T", "/PID", ppid], capture_output=True)
                    killed_pids.append(int(ppid))
                    log.info(f"kill-port taskkill /T parent={ppid}")
                # Kill worker tree
                subprocess.run(["taskkill", "/F", "/T", "/PID", wpid], capture_output=True)
                killed_pids.append(int(wpid))
                log.info(f"kill-port taskkill /T worker={wpid}")
        else:
            subprocess.run(f"fuser -k {port}/tcp", shell=True, capture_output=True)
            killed_pids = [port]
    except Exception as e:
        log.warning(f"kill-port {port}: {e}")
    log.info(f"kill-port {port}: killed {killed_pids}")
    # Verify: check if any alive process still holds the port
    import time as _time
    _time.sleep(0.5)
    if sys.platform == "win32":
        chk = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
             f"$c = Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue; "
             f"if ($c) {{ $alive = $c | Where-Object {{ Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue }}; $alive.Count -gt 0 }} else {{ $false }}"],
            capture_output=True, text=True, timeout=5
        )
        still_running = chk.stdout.strip().lower() == "true"
    else:
        chk = subprocess.run(f"fuser {port}/tcp", shell=True, capture_output=True)
        still_running = chk.returncode == 0
    return {"port": port, "killed": killed_pids, "still_running": still_running}

@app.get("/api/check-port")
async def check_port(port: int = 8000):
    """Check if a port has a LISTENING process on it."""
    try:
        if sys.platform == "win32":
            r = subprocess.run(
                ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
                 f"(Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue).OwningProcess"],
                capture_output=True, text=True, timeout=5
            )
            running = bool(r.stdout.strip())
        else:
            r = subprocess.run(f"fuser {port}/tcp", shell=True, capture_output=True)
            running = r.returncode == 0
    except Exception:
        running = False
    return {"port": port, "running": running}

# ── Execute shell command in project directory ────────────────
class ExecRequest(BaseModel):
    command: str
    cwd: Optional[str] = None   # relative to PROJECTS_DIR

@app.post("/api/exec")
async def exec_command(req: ExecRequest):
    """Run a shell command inside a project folder (used by agent terminal commands)."""
    cmd = req.command.strip()
    if not cmd:
        raise HTTPException(400, "Empty command")
    # Block obviously destructive patterns
    blocked = ["rm -rf", "del /f /s", "format ", "rd /s", "rmdir /s", ":(){", "mkfs", "dd if="]
    if any(b in cmd.lower() for b in blocked):
        raise HTTPException(400, "Command blocked for safety")

    cwd = (PROJECTS_DIR / req.cwd) if req.cwd else PROJECTS_DIR
    log.info(f"Exec  {cmd!r}  cwd={cwd}")
    try:
        result = subprocess.run(
            cmd, shell=True, capture_output=True, text=True,
            cwd=str(cwd), timeout=60,
            env={**os.environ, "PYTHONUNBUFFERED": "1"}
        )
        if result.returncode == 0:
            log.info(f"Exec OK  exit=0")
        else:
            log.warning(f"Exec exit={result.returncode}\n{result.stderr[:300]}")
        return {
            "stdout":    result.stdout[-4000:],
            "stderr":    result.stderr[-1000:],
            "exit_code": result.returncode,
        }
    except subprocess.TimeoutExpired:
        log.warning(f"Exec timeout: {cmd}")
        return {"stdout": "", "stderr": "Command timed out (60 s limit)", "exit_code": -1}
    except Exception as e:
        log.error(f"Exec error: {e}", exc_info=True)
        return {"stdout": "", "stderr": str(e), "exit_code": -1}


# ── Models ────────────────────────────────────────────────────
@app.get("/api/models")
async def list_models():
    """Return all available AI models with their capabilities."""
    return [
        {
            "id": model_id,
            "display": cfg["display"],
            "max_tokens": cfg["max_tokens"],
            "description": cfg["description"],
            "recommended": cfg.get("recommended", False),
        }
        for model_id, cfg in MODEL_CONFIGS.items()
    ]

# ── File System ───────────────────────────────────────────────
class FileContent(BaseModel):
    path: str
    content: str

class FilePath(BaseModel):
    path: str

SKIP_NAMES = {'.gitkeep'}
SKIP_PREFIXES = ('.', '__')

def _should_skip(name: str) -> bool:
    return name.startswith(SKIP_PREFIXES) or name in SKIP_NAMES

@app.get("/api/fs/tree")
async def get_file_tree():
    files = {}
    for root, dirs, filenames in os.walk(PROJECTS_DIR):
        dirs[:] = [d for d in dirs if not _should_skip(d)]
        for filename in filenames:
            if _should_skip(filename):
                continue
            abs_path = Path(root) / filename
            rel_path = abs_path.relative_to(PROJECTS_DIR).as_posix()
            try:
                with open(abs_path, "r", encoding="utf-8") as f:
                    files[rel_path] = f.read()
            except UnicodeDecodeError:
                files[rel_path] = "<binary>"
            except Exception as e:
                log.warning(f"Read error {rel_path}: {e}")
    log.debug(f"File tree  {len(files)} files")
    return files

@app.post("/api/fs/save")
async def save_file(file: FileContent):
    try:
        abs_path = PROJECTS_DIR / file.path
        abs_path.parent.mkdir(parents=True, exist_ok=True)
        with open(abs_path, "w", encoding="utf-8") as f:
            f.write(file.content)
        size = len(file.content)
        log.info(f"Saved  {file.path}  ({size:,} chars)")
        return {"status": "ok", "path": file.path}
    except Exception as e:
        log.error(f"Save failed {file.path}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/fs/delete")
async def delete_item(item: FilePath):
    try:
        abs_path = PROJECTS_DIR / item.path
        if not abs_path.exists():
            raise HTTPException(status_code=404, detail="Not found")
        kind = "dir" if abs_path.is_dir() else "file"
        if abs_path.is_dir(): shutil.rmtree(abs_path)
        else:                  abs_path.unlink()
        log.info(f"Deleted  {item.path}  ({kind})")
        return {"status": "deleted"}
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"Delete failed {item.path}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/fs/rename")
async def rename_item(item: FileContent):
    try:
        old = PROJECTS_DIR / item.path
        new = PROJECTS_DIR / item.content
        if not old.exists():  raise HTTPException(status_code=404, detail="Not found")
        if new.exists():      raise HTTPException(status_code=400, detail="Already exists")
        old.rename(new)
        log.info(f"Renamed  {item.path}  →  {item.content}")
        return {"status": "renamed", "from": item.path, "to": item.content}
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"Rename failed {item.path}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

# ── Projects ──────────────────────────────────────────────────
@app.get("/api/projects")
async def list_projects():
    """Return all top-level project folders."""
    projects = []
    if PROJECTS_DIR.exists():
        for item in sorted(PROJECTS_DIR.iterdir()):
            if item.is_dir() and not _should_skip(item.name):
                # Attach metadata: file count + last modified
                file_count = sum(1 for _ in item.rglob("*") if _.is_file() and not _should_skip(_.name))
                history_file = HISTORY_DIR / f"{item.name}.json"
                last_chat = None
                if history_file.exists():
                    try:
                        with open(history_file) as hf:
                            h = json.load(hf)
                            last_chat = h.get("updated")
                    except Exception:
                        pass
                projects.append({
                    "name": item.name,
                    "file_count": file_count,
                    "last_chat": last_chat
                })
    return projects

# ── Conversation History ──────────────────────────────────────
class ConversationSave(BaseModel):
    messages: list   # [{role, content, timestamp?}]

@app.get("/api/projects/{project}/history")
async def get_history(project: str):
    """Load conversation history for a project."""
    history_file = HISTORY_DIR / f"{project}.json"
    if history_file.exists():
        try:
            with open(history_file, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"project": project, "messages": [], "updated": None}

@app.post("/api/projects/{project}/history")
async def save_history(project: str, data: ConversationSave):
    """Persist conversation history for a project (last 100 messages)."""
    history_file = HISTORY_DIR / f"{project}.json"
    payload = {
        "project": project,
        "updated": datetime.now().isoformat(),
        "messages": data.messages[-100:]
    }
    with open(history_file, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
    return {"status": "saved", "count": len(payload["messages"])}

@app.delete("/api/projects/{project}/history")
async def clear_history(project: str):
    """Clear conversation history for a project."""
    history_file = HISTORY_DIR / f"{project}.json"
    if history_file.exists():
        history_file.unlink()
    return {"status": "cleared"}

# ── Run Python file ───────────────────────────────────────────
@app.post("/api/run")
async def run_file(request: RunRequest):
    path = PROJECTS_DIR / request.path
    if not path.is_file():
        raise HTTPException(404, "File not found")
    ext = path.suffix.lower()
    if ext != ".py":
        raise HTTPException(400, f"Cannot run {ext} files — only .py supported")
    log.info(f"Run  {request.path}")
    try:
        t0 = time.perf_counter()
        result = subprocess.run(
            [sys.executable, str(path.absolute())],
            capture_output=True, text=True, timeout=30,
            cwd=str(path.parent.absolute())
        )
        elapsed = (time.perf_counter() - t0) * 1000
        if result.returncode == 0:
            log.info(f"Run OK  {request.path}  exit=0  {elapsed:.0f}ms")
        else:
            log.warning(f"Run failed  {request.path}  exit={result.returncode}  {elapsed:.0f}ms\n{result.stderr[:300]}")
        return {
            "stdout":    result.stdout,
            "stderr":    result.stderr,
            "exit_code": result.returncode
        }
    except subprocess.TimeoutExpired:
        log.warning(f"Run timeout  {request.path}")
        return {"stdout": "", "stderr": "⏱ Execution timed out (30 s limit)", "exit_code": -1}
    except Exception as e:
        log.error(f"Run error {request.path}: {e}", exc_info=True)
        return {"stdout": "", "stderr": str(e), "exit_code": -1}


# ── WebSocket: streaming Python execution ─────────────────────
@app.websocket("/ws/run")
async def ws_run(websocket: WebSocket):
    await websocket.accept()
    process = None

    try:
        init = await websocket.receive_json()
        raw_path = init.get("path", "")
        path = (PROJECTS_DIR / raw_path).resolve()
        log.info(f"WS Run  {raw_path}")

        if not path.exists() or not path.is_file() or path.suffix.lower() != ".py":
            log.warning(f"WS Run invalid path: {raw_path}")
            await websocket.send_json({"type": "stderr", "data": f"Error: Invalid Python file path: {raw_path}\n"})
            await websocket.send_json({"type": "exit", "code": 1})
            return


        # Use Popen directly to avoid loop compatibility issues on Windows
        process = subprocess.Popen(
            [sys.executable, "-u", str(path)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=str(path.parent),
            env={**os.environ, "PYTHONUNBUFFERED": "1"},
            text=False,
            bufsize=0
        )

        output_queue = asyncio.Queue()
        loop = asyncio.get_running_loop()

        def reader(pipe, kind):
            try:
                while True:
                    data = pipe.read(1) # Read 1 byte at a time for maximum responsiveness
                    if not data: 
                        break
                    text = data.decode("utf-8", errors="replace")
                    asyncio.run_coroutine_threadsafe(output_queue.put({"type": kind, "data": text}), loop)
            except Exception as e:
                print(f"Reader error ({kind}): {e}")
            finally:
                pipe.close()

        # Start reader threads
        from threading import Thread
        t1 = Thread(target=reader, args=(process.stdout, "stdout"), daemon=True)
        t2 = Thread(target=reader, args=(process.stderr, "stderr"), daemon=True)
        t1.start()
        t2.start()

        await websocket.send_json({"type": "started"})

        async def send_updates():
            while True:
                msg = await output_queue.get()
                await websocket.send_json(msg)
                output_queue.task_done()

        update_task = asyncio.create_task(send_updates())

        # Stdin and Exit monitoring
        while True:
            try:
                # Check if process ended
                ret = process.poll()
                if ret is not None:
                    # Give some time for pipes to flush
                    await asyncio.sleep(0.5)
                    break

                # Handle WebSocket messages with timeout
                msg = await asyncio.wait_for(websocket.receive_json(), timeout=0.1)
                
                if msg.get("type") == "stdin":
                    data = msg.get("data", "")
                    if process.stdin:
                        process.stdin.write((data + "\n").encode("utf-8"))
                        process.stdin.flush()
                elif msg.get("type") == "kill":
                    process.terminate()
                    break
            except asyncio.TimeoutError:
                continue
            except WebSocketDisconnect:
                break
            except Exception as e:
                print(f"Stdin error: {e}")
                break

        # Cleanup
        update_task.cancel()
        ret = process.poll()
        if ret is None:
            process.terminate()
            ret = process.wait(timeout=2)
        
        try:
            await websocket.send_json({"type": "exit", "code": ret if ret is not None else 1})
        except:
            pass


    except WebSocketDisconnect:
        log.debug("WS Run: client disconnected")
    except Exception as e:
        log.error(f"WS Run fatal: {e}", exc_info=True)
        try:
            await websocket.send_json({"type": "stderr", "data": f"Internal Error: {e}\n"})
            await websocket.send_json({"type": "exit", "code": 1})
        except: pass
    finally:
        if process:
            try:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=1)
            except:
                try: process.kill()
                except: pass


# ── WebSocket: interactive shell terminal ─────────────────────
@app.websocket("/ws/terminal")
async def ws_terminal(websocket: WebSocket):
    await websocket.accept()
    log.info("WS Shell: connected")
    process = None
    try:
        shell_cmd = ["cmd.exe"] if sys.platform == "win32" else ["/bin/bash", "--norc", "--noprofile"]
        process = subprocess.Popen(
            shell_cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            cwd=str(PROJECTS_DIR),
            text=False,
            bufsize=0,
            env={**os.environ, "PYTHONUNBUFFERED": "1"}
        )

        output_queue = asyncio.Queue()
        loop = asyncio.get_running_loop()

        def shell_reader(pipe):
            try:
                while True:
                    data = pipe.read(256)
                    if not data:
                        break
                    text = data.decode("utf-8", errors="replace")
                    asyncio.run_coroutine_threadsafe(
                        output_queue.put({"type": "stdout", "data": text}), loop
                    )
            except Exception as e:
                print(f"Shell reader error: {e}")
            finally:
                pipe.close()

        from threading import Thread
        t = Thread(target=shell_reader, args=(process.stdout,), daemon=True)
        t.start()

        async def send_shell_updates():
            while True:
                msg = await output_queue.get()
                await websocket.send_json(msg)
                output_queue.task_done()

        update_task = asyncio.create_task(send_shell_updates())
        await websocket.send_json({"type": "started"})

        while True:
            try:
                ret = process.poll()
                if ret is not None:
                    await asyncio.sleep(0.3)
                    break
                msg = await asyncio.wait_for(websocket.receive_json(), timeout=0.1)
                if msg.get("type") == "stdin":
                    data = msg.get("data", "")
                    if process.stdin:
                        process.stdin.write((data + "\n").encode("utf-8"))
                        process.stdin.flush()
                elif msg.get("type") == "ctrl_c":
                    # Send Ctrl+C to interrupt running server (uvicorn/python) without killing shell
                    if process.stdin:
                        process.stdin.write(b"\x03")
                        process.stdin.flush()
                elif msg.get("type") == "kill":
                    process.terminate()
                    break
            except asyncio.TimeoutError:
                continue
            except WebSocketDisconnect:
                break
            except Exception as e:
                print(f"Shell stdin error: {e}")
                break

        update_task.cancel()
        ret = process.poll()
        if ret is None:
            process.terminate()
            ret = process.wait(timeout=2)
        try:
            await websocket.send_json({"type": "exit", "code": ret if ret is not None else 0})
        except:
            pass

    except WebSocketDisconnect:
        log.debug("WS Shell: client disconnected")
    except Exception as e:
        log.error(f"WS Shell fatal: {e}", exc_info=True)
        try:
            await websocket.send_json({"type": "stdout", "data": f"Error: {e}\n"})
            await websocket.send_json({"type": "exit", "code": 1})
        except: pass
    finally:
        log.info("WS Shell: closed")
        if process:
            try:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=1)
            except:
                try: process.kill()
                except: pass


# ── pip install ────────────────────────────────────────────────
@app.post("/api/pip")
async def pip_install(request: PipRequest):
    pkg = request.package.strip()
    if not pkg:
        raise HTTPException(400, "Empty package name")
    log.info(f"pip install  {pkg}")
    try:
        t0 = time.perf_counter()
        result = subprocess.run(
            [sys.executable, "-m", "pip", "install", pkg],
            capture_output=True, text=True, timeout=120
        )
        elapsed = (time.perf_counter() - t0) * 1000
        if result.returncode == 0:
            log.info(f"pip OK  {pkg}  {elapsed:.0f}ms")
        else:
            log.warning(f"pip FAILED  {pkg}  exit={result.returncode}\n{result.stderr[:300]}")
        return {
            "stdout":    result.stdout[-4000:],
            "stderr":    result.stderr[-1000:],
            "exit_code": result.returncode
        }
    except subprocess.TimeoutExpired:
        log.warning(f"pip timeout  {pkg}")
        return {"stdout": "", "stderr": "pip install timed out", "exit_code": -1}
    except Exception as e:
        log.error(f"pip error {pkg}: {e}", exc_info=True)
        return {"stdout": "", "stderr": str(e), "exit_code": -1}


# ── Code completion (jedi) ─────────────────────────────────────
@app.post("/api/complete")
async def complete_code(request: CompleteRequest):
    try:
        import jedi
        script = jedi.Script(request.code)
        completions = script.complete(request.line, request.col)
        return [
            {
                "name":        c.name,
                "type":        c.type,
                "description": (c.description or "")[:80]
            }
            for c in completions[:20]
        ]
    except ImportError:
        return []          # jedi not installed — frontend falls back to keywords
    except Exception:
        return []


# ── GitHub Integration ──────────────────────────────────────────
class GitHubPublishRequest(BaseModel):
    project_name: str
    github_user: Optional[str] = None
    github_token: Optional[str] = None
    repo_name: Optional[str] = None
    is_private: bool = False

@app.post("/api/github/publish")
async def publish_to_github(req: GitHubPublishRequest):
    project_path = PROJECTS_DIR / req.project_name
    if not project_path.exists() or not project_path.is_dir():
        raise HTTPException(404, f"Project {req.project_name} not found")

    # Use provided credentials or fall back to environment variables
    gh_user = req.github_user or os.getenv("GITHUB_USER")
    gh_token = req.github_token or os.getenv("GITHUB_TOKEN")
    
    if not gh_user or not gh_token:
        raise HTTPException(400, "GitHub username and token are required. Set GITHUB_USER and GITHUB_TOKEN in .env or provide them in the request.")

    repo_name = req.repo_name or req.project_name
    
    log.info(f"GitHub Publish: project={req.project_name} repo={repo_name} user={gh_user}")

    try:
        # 1. Create Repository on GitHub
        headers = {
            "Authorization": f"token {gh_token}",
            "Accept": "application/vnd.github.v3+json"
        }
        data = {
            "name": repo_name,
            "private": req.is_private,
            "description": f"Published from VibeCode IDE - {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
        }
        
        create_res = requests.post("https://api.github.com/user/repos", headers=headers, json=data)
        
        if create_res.status_code == 201:
            log.info(f"GitHub repo created: {repo_name}")
        elif create_res.status_code == 422:
            log.warning(f"GitHub repo already exists: {repo_name}")
            # We continue anyway, assuming the user wants to push to existing repo
        elif create_res.status_code == 403:
            log.error(f"GitHub API error: {create_res.status_code} {create_res.text}")
            raise HTTPException(403, "GitHub API error 403: Forbidden. This usually means your Personal Access Token (PAT) lacks the required 'repo' scope (for Classic tokens) or 'Contents: Write' permission (for Fine-grained tokens).")
        else:
            log.error(f"GitHub API error: {create_res.status_code} {create_res.text}")
            raise HTTPException(create_res.status_code, f"GitHub API error: {create_res.text}")

        # 2. Git Operations
        def run_git(args, cwd=project_path):
            result = subprocess.run(["git"] + args, cwd=str(cwd), capture_output=True, text=True)
            if result.returncode != 0:
                log.error(f"Git error ({args}): {result.stderr}")
            return result

        # Initialize git if not already
        if not (project_path / ".git").exists():
            run_git(["init"])
            run_git(["checkout", "-b", "main"])

        # Configure user if not set (local to repo)
        run_git(["config", "user.name", gh_user])
        run_git(["config", "user.email", f"{gh_user}@users.noreply.github.com"])

        # Add and commit
        run_git(["add", "."])
        run_git(["commit", "-m", "Initial commit from VibeCode"])

        # Remote operations
        remote_url = f"https://{gh_user}:{gh_token}@github.com/{gh_user}/{repo_name}.git"
        
        # Check if remote exists, update if it does, add if it doesn't
        remotes = run_git(["remote"]).stdout.splitlines()
        if "origin" in remotes:
            run_git(["remote", "set-url", "origin", remote_url])
        else:
            run_git(["remote", "add", "origin", remote_url])

        # Push
        push_res = run_git(["push", "-u", "origin", "main"])
        
        if push_res.returncode == 0:
            log.info(f"Successfully pushed to GitHub: {gh_user}/{repo_name}")
            return {
                "status": "ok",
                "repo_url": f"https://github.com/{gh_user}/{repo_name}",
                "message":f"Project successfully published to GitHub!"
            }
        else:
            raise HTTPException(500, f"Git push failed: {push_res.stderr}")

    except Exception as e:
        log.error(f"Publish failed: {e}", exc_info=True)
        if isinstance(e, HTTPException): raise e
        raise HTTPException(500, str(e))

# ── Health ────────────────────────────────────────────────────
@app.get("/api/health")
async def health():
    return {"status": "ok"}

# ── Frontend ──────────────────────────────────────────────────
@app.get("/")
async def serve_frontend():
    idx = VIBECODE_DIR / "index.html"
    return FileResponse(idx) if idx.exists() else {"error": "UI not found"}

if VIBECODE_DIR.exists():
    app.mount("/", StaticFiles(directory=str(VIBECODE_DIR)), name="vibecode")

if __name__ == "__main__":
    # Use PORT from environment for cloud deployment (e.g. Render)
    port = int(os.environ.get("PORT", 8001))
    log.info("=" * 48)
    log.info(f"VibeCode IDE  ->  http://localhost:{port}")
    log.info(f"   Projects  : {PROJECTS_DIR}")
    log.info(f"   History   : {HISTORY_DIR}")
    log.info("=" * 48)
    uvicorn.run(
        "main:app", host="0.0.0.0", port=port, reload=False,
        log_level="warning",   # suppress uvicorn's own duplicate access log
    )
