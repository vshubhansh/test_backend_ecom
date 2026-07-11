FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
# npm ci once package-lock.json exists; install keeps the first build working without it.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY src ./src

EXPOSE 3005

CMD ["node", "src/server.js"]
