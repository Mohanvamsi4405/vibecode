import asyncio
import os
import json
from pathlib import Path
from agent_service import run_agent_pipeline

# Mocking PROJECTS_DIR
PROJECTS_DIR = Path(os.getcwd()) / "vibecode_projects"
PROJECTS_DIR.mkdir(exist_ok=True)

async def test_pipeline():
    user_message = """The "AstraVanta AI" Design & Code Prompt Role: Senior UI/UX Designer & Creative Technologist from a Tier-1 Silicon Valley AI Startup. Project: AstraVanta AI — A Series-A funded enterprise AI & Automation consultancy. Design Goal: Create a high-conversion, futuristic, and technically superior landing page that establishes immediate authority for high-ticket clients (Healthcare, Real Estate, Construction, SMEs)."""
    
    project_name = "astravanta_test"
    model_id = "moonshotai/kimi-k2-instruct-0905" # The one that failed before
    
    print(f"Starting pipeline for {project_name}...")
    
    async for event in run_agent_pipeline(
        user_message=user_message,
        files={},
        project_name=project_name,
        model_id=model_id,
        projects_dir=PROJECTS_DIR
    ):
        event_type = event.get("event")
        agent = event.get("agent", "global")
        
        if event_type == "agent_start":
            print(f"[{agent}] Starting: {event.get('message')}")
        elif event_type == "agent_done":
            output = event.get("output", {})
            actions = output.get("actions", [])
            print(f"[{agent}] Done! Generated {len(actions)} actions.")
            for a in actions:
                path = PROJECTS_DIR / a["file"]
                print(f" - Writing: {a.get('file')}")
                path.parent.mkdir(parents=True, exist_ok=True)
                with open(path, "w", encoding="utf-8") as f:
                    f.write(a.get("content", ""))
        elif event_type == "error":
            print(f"[{agent}] ERROR: {event.get('message')}")
        elif event_type == "pipeline_done":
            print("Pipeline completed successfully!")

if __name__ == "__main__":
    asyncio.run(test_pipeline())
