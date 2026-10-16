# Production image for Nest voice RTC (Silero VAD via onnxruntime needs glibc; STT is FastAPI, TTS is Edge).
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
# Coolify's healthcheck shells out to curl/wget; slim images ship neither.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Bake Silero VAD into the image so a cold start never waits on Hugging Face.
RUN node -e "require('./dist/audio/vad').loadSilero().then(()=>process.exit(0),e=>{console.error(e);process.exit(1)})"
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/rtc/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
