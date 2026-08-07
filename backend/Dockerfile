FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Run as a non-root user. EFS file access in the deployed stack is unaffected:
# the EFS access point enforces its own POSIX identity for all file operations.
# /app stays writable for the local-dev SQLite database.
RUN useradd --system --uid 1000 --create-home appuser \
  && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000
# Container-level liveness (ALB target-group checks cover the deployed stack;
# this also covers local/compose usage). python stdlib -- no curl in slim.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health', timeout=3).status == 200 else 1)"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
