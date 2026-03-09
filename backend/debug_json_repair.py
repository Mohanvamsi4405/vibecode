import json
import re

def repair_json(raw):
    """Recover the most complete partial JSON by scanning closing braces."""
    start = raw.find('{')
    if start == -1: return None
    raw = raw[start:]
    
    try: return json.loads(raw)
    except: pass

    # Close open string
    if raw.count('"') % 2 != 0:
        raw += '"'
    
    # Stack-based closing
    stack = []
    in_string = False
    escaped = False
    
    for char in raw:
        if char == '"' and not escaped:
            in_string = not in_string
        elif char == '\\' and not escaped:
            escaped = True
            continue
        elif not in_string:
            if char == '{': stack.append('}')
            elif char == '[': stack.append(']')
            elif char == '}': 
                if stack and stack[-1] == '}': stack.pop()
            elif char == ']':
                if stack and stack[-1] == ']': stack.pop()
        escaped = False
        
    if in_string:
        raw += '"'
    
    # Close everything in reverse
    while stack:
        raw += stack.pop()
        
    try:
        return json.loads(raw)
    except:
        # Attempt to remove trailing commas before closing braces
        # This is simple but usually effective for common failure modes
        raw = re.sub(r',(\s*[}\]])', r'\1', raw)
        try: return json.loads(raw)
        except: return None

# Test with the user's failed snippet (truncated version)
failed_raw = """
{
  "actions": [
    {
      "action": "add_file",
      "file": "AstraVanta/index.html",
      "content": "<!DOCTYPE html>\\n<html lang=\\"en\\">\\n<head>\\n  <meta charset=\\"UTF-8\\">\\n  <meta name=\\"viewport\\" content=\\"width=device-width, initial-scale=1.0\\">"
    },
    {
      "action": "add_file",
      "file": "AstraVanta/styles.css",
      "content": "body { background: black; "
"""

print("Attempting repair...")
result = repair_json(failed_raw)
if result:
    print("Repair success!")
    print(json.dumps(result, indent=2))
else:
    print("Repair failed.")
