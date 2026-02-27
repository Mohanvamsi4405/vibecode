from pydantic import BaseModel
from typing import Dict, List, Optional

class ChatRequest(BaseModel):
    message: str
    files: Dict[str, str]
    current_file: Optional[str] = None
    history: Optional[List[Dict[str, str]]] = []
    project_name: Optional[str] = None     # Active project for memory context
    model: Optional[str] = None             # AI model ID (falls back to DEFAULT_MODEL)

class FileAction(BaseModel):
    action: str           # add_file | replace_file | patch_file | delete_file
    file: str
    content: Optional[str] = None   # add_file / replace_file
    search: Optional[str] = None    # patch_file — exact string to find
    replace: Optional[str] = None   # patch_file — replacement string

class ChatResponse(BaseModel):
    actions: List[FileAction]
    message: Optional[str] = None

class RunRequest(BaseModel):
    path: str                          # relative path e.g. "my-app/main.py"

class PipRequest(BaseModel):
    package: str                       # package name e.g. "requests" or "flask==3.0"

class CompleteRequest(BaseModel):
    code: str                          # full source text
    line: int                          # 1-based line number
    col: int                           # 0-based column
    path: Optional[str] = None         # hint for jedi (e.g. "my-app/main.py")
