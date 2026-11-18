FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY *.py .
RUN python -m unittest -q test_normalize test_build test_sdk
USER nobody
EXPOSE 8090
CMD ["python", "server.py"]
