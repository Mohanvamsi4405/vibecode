# 🚀 VibeCode Deployment Guide

This guide will help you deploy your VibeCode application to various platforms, including free cloud hosting options.

## 📋 Prerequisites
- **Groq API Key**: Obtain one from [GroqCloud Console](https://console.groq.com/).
- **GitHub Account**: Required for some automated deployments.
- **Python 3.8+** (for manual deployment).
- **Docker** (optional, for containerized deployment).

---

## ☁️ Free Cloud Hosting Suggestions

Here are the best free cloud platforms for hosting VibeCode:

### 1. [Render](https://render.com/) (Recommended)
- **Why**: Excellent free tier for web services.
- **Workflow**:
    1. Connect your GitHub repository.
    2. Select **"Web Service"**.
    3. **Runtime**: `Python`.
    4. **Build Command**: `pip install -r backend/requirements.txt`.
    5. **Start Command**: `cd backend && python main.py`.
    6. **Environment Variables**: Add `GROQ_API_KEY`.
- **Note**: The free tier spins down after inactivity, causing a slight delay on the first request.

### 2. [Koyeb](https://www.koyeb.com/)
- **Why**: Solid free tier that supports Docker.
- **Workflow**:
    1. Connect GitHub or use the Docker image.
    2. Koyeb will detect the `Dockerfile` automatically.
    3. Set `GROQ_API_KEY` in environment variables.
    4. Set the port to `8001` (as configured in `main.py`).

### 3. [Hugging Face Spaces](https://huggingface.co/spaces)
- **Why**: Dedicated to AI/ML apps, completely free, and lasts longer before sleeping.
- **Workflow**:
    1. Create a new Space.
    2. Select **Docker** as the SDK.
    3. Upload your code or sync with GitHub.
    4. Add your `GROQ_API_KEY` to the Space Secrets.

---

## 🐳 Docker Deployment (Self-Hosted)

If you have your own server or want to run locally with Docker:

1. **Build the image**:
   ```bash
   docker build -t vibecode .
   ```
2. **Run the container**:
   ```bash
   docker run -d -p 8000:8001 -e GROQ_API_KEY=your_key_here vibecode
   ```

### Using Docker Compose
1. Ensure your `.env` file in the root directory contains `GROQ_API_KEY`.
2. Run:
   ```bash
   docker-compose up -d
   ```

---

## 🛠️ Manual Deployment (Any VPS)

If you're deploying to a standard Linux VPS (like Oracle Free Tier, AWS Free Tier, or DigitalOcean):

1. **Clone the repo**:
   ```bash
   git clone <your-repo-url>
   cd <repo-name>
   ```
2. **Setup virtual environment**:
   ```bash
   python -m venv venv
   source venv/bin/activate  # Windows: venv\Scripts\activate
   ```
3. **Install dependencies**:
   ```bash
   pip install -r backend/requirements.txt
   ```
4. **Configure Environment**:
   Create a `.env` file in the `backend/` folder:
   ```env
   GROQ_API_KEY=your_actual_key_here
   ```
5. **Start with Uvicorn (Production)**:
   ```bash
   cd backend
   uvicorn main:app --host 0.0.0.0 --port 8001
   ```

---

## 🔧 Environment Variables Reference

| Variable | Description | Required |
|----------|-------------|----------|
| `GROQ_API_KEY` | Your Groq Cloud API Key | Yes |
| `GITHUB_USER` | Your GitHub Username (for publishing) | Optional |
| `GITHUB_TOKEN` | GitHub Personal Access Token | Optional |
| `PORT` | Port for the server (default: 8001) | No |

---

## 🔌 Previewing Sub-Projects (Port Proxy)
When running backends like **FastAPI** or **Flask** inside VibeCode on Render, you encounter a "single port" limitation. VibeCode solves this with a built-in Proxy:

1.  **Start your server** in the VibeCode Terminal:
    ```bash
    uvicorn main:app --port 8000
    ```
2.  **Toggle the Proxy** in the Preview pane (click the 🔌/🖥️ icon).
3.  **Specify the Port**: Use the `#` input field next to the proxy button to set the internal port (e.g., `8000`).
4.  VibeCode will now route your preview requests through `https://your-app.onrender.com/proxy/8000/`.

---

## 📂 Data Persistence
VibeCode stores your projects in `vibecode_projects/` and chat history in `.vc_history/`.
- **Docker**: These are mapped to volumes in `docker-compose.yml`.
- **Cloud**: Most free tiers have ephemeral storage (files will be deleted on restart). Use the **GitHub Publishing** feature in the IDE to save your work permanently!
