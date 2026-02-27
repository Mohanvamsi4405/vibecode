import asyncio
import json
import websockets

async def test_run():
    uri = "ws://localhost:8000/ws/run"
    try:
        async with websockets.connect(uri) as websocket:
            # Test case: run mohan/mohan.py
            payload = {"path": "mohan/mohan.py"}
            await websocket.send(json.dumps(payload))
            print(f"Sent: {payload}")

            stdout_buffer = ""
            while True:
                response = await websocket.recv()
                msg = json.loads(response)
                
                if msg["type"] == "stdout":
                    stdout_buffer += msg["data"]
                    print(msg["data"], end="", flush=True)

                if "Enter a positive integer" in stdout_buffer and "Sent stdin: 5" not in locals().get("log", []):
                    # Simulate user input
                    await websocket.send(json.dumps({"type": "stdin", "data": "5"}))
                    print("\n[Sent stdin: 5]")
                    if "log" not in locals(): log = []
                    log.append("Sent stdin: 5")
                
                if "Reverse of 5 is 5" in stdout_buffer and "Sent stdin: 0" not in locals().get("log", []):
                    # Exit the script
                    await websocket.send(json.dumps({"type": "stdin", "data": "0"}))
                    print("\n[Sent stdin: 0]")
                    if "log" not in locals(): log = []
                    log.append("Sent stdin: 0")

                if msg["type"] == "exit":
                    print(f"\nProcess exited with code: {msg['code']}")
                    break
    except Exception as e:
        print(f"\nError: {e}")

if __name__ == "__main__":
    asyncio.run(test_run())
