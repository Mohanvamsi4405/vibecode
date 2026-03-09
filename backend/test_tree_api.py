import requests
import json

try:
    resp = requests.get("http://localhost:8001/api/fs/tree")
    if resp.ok:
        data = resp.json()
        files = sorted(data.keys())
        print(f"Total files: {len(files)}")
        print("Top 10 files:")
        for f in files[:10]:
            print(f" - {f}")
            
        projects = set()
        for f in files:
            projects.add(f.split('/')[0])
            
        print("\nProjects found in tree:")
        for p in sorted(projects):
            print(f" - {p}")
    else:
        print(f"Error: {resp.status_code}")
except Exception as e:
    print(f"Failed: {e}")
