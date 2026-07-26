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
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
