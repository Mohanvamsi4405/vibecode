# Contributing to VibeCode

Thanks for your interest in contributing! This guide will get you from zero to your first PR.

---

## Table of Contents

- [Ways to Contribute](#ways-to-contribute)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Making Changes](#making-changes)
- [Submitting a PR](#submitting-a-pr)
- [Code Style](#code-style)
- [Good First Issues](#good-first-issues)

---

## Ways to Contribute

- **Bug reports** — open an issue with steps to reproduce
- **Feature requests** — open an issue describing what you want and why
- **Code** — fix a bug, implement a feature, improve docs
- **Docs** — improve README, add examples, fix typos
- **Testing** — try it on different platforms and report what breaks

---

## Development Setup

### 1. Fork & clone

```bash
git clone https://github.com/<your-username>/vibecode.git
cd vibecode
```

### 2. Install dependencies

```bash
cd backend
pip install -r requirements.txt
```

### 3. Set up your API key

```bash
# backend/.env
GROQ_API_KEY=your_groq_key_here
```

Get a free key at [console.groq.com](https://console.groq.com/).

### 4. Run

```bash
python main.py
# Open http://localhost:8001
```

That's it — no build step, no npm, no Docker required for local dev.

---

## Project Structure

```
backend/
  main.py          — FastAPI server + all endpoints
  agent_service.py — LangGraph AI pipeline (this is where most AI logic lives)
  groq_service.py  — Groq API wrapper
  schemas.py       — Pydantic models

vibecode/
  index.html       — Single-page app shell
  script.js        — All frontend logic
  style.css        — All styles
```

**Where to look for common changes:**

| What you want to change | File |
|---|---|
| How the AI plans/codes projects | `backend/agent_service.py` — `PLANNER_PROMPT`, `CODER_PROMPT` |
| How the AI generates terminal commands | `backend/agent_service.py` — `TERMINAL_PROMPT` |
| A new API endpoint | `backend/main.py` |
| UI layout or new button | `vibecode/index.html` + `vibecode/style.css` |
| Frontend event handling / terminal behavior | `vibecode/script.js` |
| Port proxy behavior | `backend/main.py` — `proxy_request()` |

---

## Making Changes

### Branch naming

```
fix/short-description       # bug fixes
feat/short-description      # new features
docs/short-description      # documentation only
```

### Commit messages

Use the format: `type: short description`

```
fix: handle missing requirements.txt gracefully
feat: add syntax highlighting for Python files
docs: add troubleshooting section to README
```

Types: `fix`, `feat`, `docs`, `refactor`, `style`, `chore`

---

## Submitting a PR

1. Create a branch from `main`
2. Make your changes
3. Test locally — open the IDE, run a prompt, verify your change works
4. Push and open a PR against `main`
5. Describe what you changed and why in the PR description

For bug fixes, include:
- What the bug was
- What caused it
- How your fix addresses the root cause

---

## Code Style

### Python (backend)
- Follow existing patterns — no strict linter enforced yet
- Use `log.info()` / `log.warning()` for logging (logger is `log = _make_logger("vibecode")`)
- Platform checks: `sys.platform == "win32"` for Windows-specific code
- Keep SSE streaming consistent: `data: {json}\n\n` format

### JavaScript (frontend)
- No framework, no transpilation — plain ES6+
- State lives in `Store.state` — always use `Store.save()` after mutating
- Terminal output: always use `_termAppend(text, cls)`, never touch DOM directly
- Keep event handling in the `_handleAgentEvent()` switch-case

### General
- Don't add dependencies without a good reason — the frontend has zero npm deps intentionally
- Don't add databases — use in-memory or JSON files to stay lightweight
- If you add a new SSE event type, document it in both `agent_service.py` and the handler in `script.js`

---

## Good First Issues

Look for issues labeled [`good first issue`](../../issues?q=label%3A%22good+first+issue%22) — these are scoped, well-described, and don't require deep knowledge of the whole codebase.

Some areas that are generally approachable:
- Improving agent prompts (no code changes, just prompt engineering)
- Adding keyboard shortcuts in the editor
- Improving error messages shown in the terminal
- Adding a new UI theme / color scheme
- Writing more test prompts and documenting expected behavior

---

## Questions?

Open a [Discussion](../../discussions) or comment on any issue. Happy to help you get oriented.
