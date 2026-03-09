# Use an official Python runtime as a parent image
FROM python:3.10-slim

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE 1
ENV PYTHONUNBUFFERED 1
ENV PORT 8001

# Set work directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git bash curl procps \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY backend/requirements.txt /app/backend/
RUN pip install --no-cache-dir -r backend/requirements.txt

# Copy backend files
COPY backend/ /app/backend/

# Copy frontend (vibecode directory)
# The backend/main.py expects VIBECODE_DIR to be ../vibecode relative to backend/
COPY vibecode/ /app/vibecode/

# Create projects and history directories and set permissions
RUN mkdir -p /app/vibecode_projects /app/.vc_history && \
    chmod -R 777 /app/vibecode_projects /app/.vc_history

# Expose the port
EXPOSE 8001

# Set workdir to backend for starting the server
WORKDIR /app/backend

# Command to run the application
# We use uvicorn to serve the FastAPI app
CMD ["python", "main.py"]
