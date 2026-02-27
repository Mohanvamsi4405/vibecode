# Claude Code Clone (Groq Powered)

A browser-based AI coding assistant that uses GroqCloud to modify code in real-time.

## Project Structure
- `backend/`: FastAPI server
- `frontend/`: Monaco-based editor and preview

## Setup Instructions

### 1. Prerequisites
- Python 3.8+
- Groq API Key

### 2. Backend Setup
1. Navigate to the `backend` folder.
2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```
3. Create a `.env` file in the `backend/` directory:
   ```env
   GROQ_API_KEY=your_groq_api_key_here
   ```
4. Start the server:
   ```bash
   python main.py
   ```
   The backend will run on `http://localhost:8000`.

### 3. Frontend Setup
Simply open `frontend/index.html` in any modern web browser. No compilation needed!

## Features
- **Virtual File System**: Edit multiple files in memory.
- **Monaco Editor**: Professional-grade editor experience.
- **Live Preview**: Instant updates to an iframe as you code.
- **AI Chat**: Ask Groq to modify your code, and it will apply changes directly to your files.

## How to Use
1. Open `index.html`.
2. Type a request in the chat (e.g., "Add a dark mode button").
3. The AI will provide specialized JSON instructions, and the code will update automatically!
