import json
from pathlib import Path

log_path = Path(r"d:\CodewithAi\vibecode_projects\ecommerce-tshirts\.agent_logs\20260302_144650.json")
project_dir = Path(r"d:\CodewithAi\vibecode_projects\ecommerce-tshirts")

if log_path.exists():
    with open(log_path, "r", encoding="utf-8") as f:
        data = json.load(f)
        
    for agent in data.get("agents", []):
        output = agent.get("output", {})
        if isinstance(output, dict):
            actions = output.get("actions", [])
            for a in actions:
                file_path = project_dir / a["file"]
                print(f"Recovering: {file_path}")
                file_path.parent.mkdir(parents=True, exist_ok=True)
                with open(file_path, "w", encoding="utf-8") as out:
                    out.write(a["content"])
else:
    print("Log not found.")
