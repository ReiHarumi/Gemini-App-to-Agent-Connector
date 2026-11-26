# Official Playwright image includes Chromium + all required OS libraries
FROM mcr.microsoft.com/playwright:v1.52.0-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=3000
ENV HEADLESS=true

EXPOSE 3000

CMD ["node", "dist/index.js"]
