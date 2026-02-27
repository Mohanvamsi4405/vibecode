# VibeCode Development Guide

This project has been migrated to use the `frontend` folder as the main application source, served by the `backend` Python server.

## 🚀 Quick Start

1.  **Start the Backend Server**:
    The backend serves the frontend and handles AI chat requests.

    ```bash
    cd backend
    uvicorn main:app --reload
    ```

2.  **Access the IDE**:
    Open your browser to:
    [http://localhost:8000](http://localhost:8000)

## 📁 Project Structure

-   **`frontend/`**: The modern VibeCode IDE (HTML, CSS, JS).
    -   `index.html`: Main entry point.
    -   `style.css`: Primary Dark Theme styles.
    -   `script.js`: UI logic, file system simulation, and API integration.
-   **`backend/`**: FastAPI server.
    -   `main.py`: Configured to serve `frontend/` at root `/`.
    -   `schemas.py`: Data models for Chat API.
    -   `groq_service.py`: AI integration logic.
-   **`vibecode/`**: (Legacy) Original source, now kept for reference or backup.

## 🛠️ Features

-   **AI Chat**: Talk to the assistant to generate code.
-   **File System**: Create, edit, rename, and delete files (persisted in browser storage).
-   **Preview**: Real-time preview of your HTML/CSS/JS code.
-   **Terminal**: Execute basic commands and see logs.

## ⚠️ Important Notes

-   **Always run the server from the `backend` directory** (`cd backend`) to ensure Python imports work correctly.
-   The frontend uses **relative paths** for assets, so it *can* be opened directly in a browser, but the **AI Chat will fail** without the backend running.
