FROM node:20-bookworm-slim

# Python runtime for mcq_to_anki.py
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps
COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

# Install Node deps
COPY package*.json ./
RUN npm ci --omit=dev

# App source
COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
