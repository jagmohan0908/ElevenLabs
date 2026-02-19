# Node.js + ffmpeg for Exotel Voice AI (Render, etc.)
FROM node:20-bookworm-slim

# Install ffmpeg for audio conversion (8kHz WAV for Exotel)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

# Render sets PORT; app uses process.env.PORT
ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "app.js"]
